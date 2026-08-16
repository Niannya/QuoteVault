import json
import math
import os
import re
import sys
import traceback
from collections import Counter
from pathlib import Path


RESULT_PREFIX = "QUOTEVault_RESULT:"


def _json_default(value):
    if hasattr(value, "tolist"):
        return value.tolist()
    return str(value)


def _color_distance(left, right):
    return math.sqrt(sum((int(a) - int(b)) ** 2 for a, b in zip(left, right)))


def _dominant_color(image, box):
    from PIL import Image

    x1, y1, x2, y2 = [int(value) for value in box]
    x1 = max(0, min(image.width - 1, x1))
    y1 = max(0, min(image.height - 1, y1))
    x2 = max(x1 + 1, min(image.width, x2))
    y2 = max(y1 + 1, min(image.height, y2))
    crop = image.crop((x1, y1, x2, y2)).convert("RGB")
    crop.thumbnail((160, 40), Image.Resampling.BILINEAR)
    quantized = crop.quantize(colors=8)
    count, color_index = max(quantized.getcolors() or [(1, 0)])
    palette = quantized.getpalette()
    offset = color_index * 3
    return tuple(palette[offset : offset + 3])


def _line_background(image, box):
    x1, y1, x2, y2 = [int(value) for value in box]
    x1 = max(0, min(image.width - 1, x1))
    x2 = max(x1 + 1, min(image.width, x2))
    regions = [
        (x1, max(0, y1 - 3), x2, min(image.height, y1 + 2)),
        (x1, max(0, y2 - 2), x2, min(image.height, y2 + 3)),
    ]
    pixels = []
    for region in regions:
        pixels.extend(image.crop(region).convert("RGB").getdata())
    return Counter(pixels).most_common(1)[0][0] if pixels else _dominant_color(image, box)


def _corridor_matches(image, previous, current):
    gap_top = int(previous["box"][3])
    gap_bottom = int(current["box"][1])
    if gap_bottom <= gap_top + 2:
        return True
    left = max(int(previous["box"][0]), int(current["box"][0]))
    right = min(int(previous["box"][2]), int(current["box"][2]))
    if right - left < 8:
        return False
    inset = max(2, (right - left) // 12)
    corridor = [left + inset, gap_top, right - inset, gap_bottom]
    corridor_color = _dominant_color(image, corridor)
    return _color_distance(corridor_color, previous["background"]) <= 48


def _looks_like_header(text):
    value = text.strip()
    return bool(
        re.search(r"\b\d{1,2}:\d{2}\s*$", value)
        or re.search(r"^\s*[@#&＆]", value)
        or re.search(r"\bLV\s*\d+", value, re.IGNORECASE)
    )


def _looks_like_level(text):
    return bool(re.search(r"^\s*(?:LV|等级)\s*\d+", text.strip(), re.IGNORECASE))


def _clean_header(text):
    value = re.sub(r"\s*\b\d{1,2}:\d{2}\s*$", "", text).strip()
    value = re.sub(r"\s*\bLV\s*\d+.*$", "", value, flags=re.IGNORECASE).strip()
    return value.strip(" \t:@#&＆·•|")


def _group_lines(image_path, texts, scores, boxes):
    from PIL import Image

    with Image.open(image_path) as source:
        image = source.convert("RGB")
        lines = []
        for text, score, box in zip(texts, scores, boxes):
            value = str(text).strip()
            if not value:
                continue
            normalized_box = [int(number) for number in box]
            lines.append(
                {
                    "text": value,
                    "score": float(score),
                    "box": normalized_box,
                    "background": _line_background(image, normalized_box),
                }
            )

        lines.sort(key=lambda item: (item["box"][1], item["box"][0]))
        # QQ 的昵称、等级徽章经常被 OCR 拆成多个并排文本框。只把含 LV/等级的整行
        # 当作界面元数据过滤掉，不返回昵称，也不尝试把它映射为成员身份。
        level_lines = [line for line in lines if _looks_like_level(line["text"])]

        def same_visual_row(left, right):
            left_height = max(1, left["box"][3] - left["box"][1])
            right_height = max(1, right["box"][3] - right["box"][1])
            left_center = (left["box"][1] + left["box"][3]) / 2
            right_center = (right["box"][1] + right["box"][3]) / 2
            return abs(left_center - right_center) <= max(left_height, right_height) * 0.8

        content_regions = [
            line for line in lines
            if not any(same_visual_row(line, level) for level in level_lines)
        ]
        blocks = []
        for line in content_regions:
            if not blocks:
                blocks.append([line])
                continue
            previous = blocks[-1][-1]
            same_background = _color_distance(previous["background"], line["background"]) <= 48
            previous_height = max(1, previous["box"][3] - previous["box"][1])
            gap = line["box"][1] - previous["box"][3]
            close_enough = gap <= max(12, previous_height * 4)
            if same_background and close_enough and _corridor_matches(image, previous, line):
                blocks[-1].append(line)
            else:
                blocks.append([line])

    nicknames = []
    messages = []
    message_details = []
    current_nickname = None
    for index, block in enumerate(blocks):
        content_lines = list(block)
        first_text = content_lines[0]["text"].strip()
        has_following_content = len(content_lines) > 1 or index + 1 < len(blocks)
        first_is_header = has_following_content and (
            _looks_like_header(first_text)
            or (len(content_lines) > 1 and _looks_like_level(content_lines[1]["text"]))
        )
        if first_is_header:
            candidate = _clean_header(first_text)
            if candidate and len(candidate) <= 40:
                current_nickname = candidate
                nicknames.append(candidate)
            content_lines = content_lines[1:]
            while content_lines and _looks_like_level(content_lines[0]["text"]):
                content_lines = content_lines[1:]

        text = "\n".join(line["text"] for line in content_lines).strip()
        if text:
            messages.append(text)
            message_details.append({"text": text, "nickname": current_nickname})

    if not messages and content_regions:
        messages = ["\n".join(line["text"] for line in content_regions)]
        message_details = [{"text": messages[0], "nickname": None}]
    # 昵称/等级只作为版面噪声过滤，不作为产品数据返回或建立身份关联。
    return lines, messages, [{"text": item["text"], "nickname": None} for item in message_details], []


def _recognize(engine, image_path):
    results = list(engine.predict(image_path))
    all_texts = []
    all_scores = []
    all_boxes = []
    for result in results:
        data = result.json if hasattr(result, "json") else result
        data = data.get("res", data)
        all_texts.extend(data.get("rec_texts", []))
        all_scores.extend(data.get("rec_scores", []))
        all_boxes.extend(data.get("rec_boxes", []))

    lines, messages, message_details, nicknames = _group_lines(image_path, all_texts, all_scores, all_boxes)
    confidence = sum(line["score"] for line in lines) / len(lines) if lines else 0.0
    return {
        "rawText": "\n".join(line["text"] for line in lines),
        "confidence": confidence,
        "messages": messages,
        "messageDetails": message_details,
        "nicknameCandidates": nicknames,
        "regions": [
            {"text": line["text"], "confidence": line["score"], "box": line["box"]}
            for line in lines
        ],
        "engine": "PaddleOCR v6 medium",
    }


def main():
    os.environ.setdefault(
        "PADDLE_PDX_CACHE_HOME",
        str(Path(os.environ.get("LOCALAPPDATA", ".")) / "QuoteVault" / "paddle-models"),
    )
    os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")
    from paddleocr import PaddleOCR

    engine = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=os.environ.get("QUOTEVault_PaddleDevice", "cpu"),
    )
    if "--install-models" in sys.argv:
        print("PaddleOCR models are ready.", flush=True)
        return
    for request_line in sys.stdin:
        request_line = request_line.strip().lstrip("\ufeff")
        if not request_line:
            continue
        request_id = None
        try:
            request = json.loads(request_line)
            request_id = request.get("id")
            image_path = request["imagePath"]
            payload = {"id": request_id, "ok": True, "output": _recognize(engine, image_path)}
        except Exception as exc:
            payload = {
                "id": request_id,
                "ok": False,
                "error": str(exc),
                "details": traceback.format_exc(limit=5),
            }
        print(RESULT_PREFIX + json.dumps(payload, ensure_ascii=True, default=_json_default), flush=True)


if __name__ == "__main__":
    main()
