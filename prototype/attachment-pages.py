"""Produce bounded visual inputs from a single saved chat upload."""
import base64
import io
import json
import math
import os
from pathlib import Path
import sys

from PIL import Image, ImageOps

EDGE = 1536
MAX_SOURCE_PIXELS = 32_000_000


def encode(image):
    image.thumbnail((EDGE, EDGE), Image.Resampling.LANCZOS)
    # Composite transparent artwork on the same white background used for PDF pages.
    if image.mode in ("RGBA", "LA") or "transparency" in image.info:
        rgba = image.convert("RGBA")
        image = Image.new("RGB", rgba.size, "white")
        image.paste(rgba, mask=rgba.getchannel("A"))
    stream = io.BytesIO()
    image.convert("RGB").save(stream, format="JPEG", quality=85)
    return base64.b64encode(stream.getvalue()).decode("ascii")


def render(fp, start, limit):
    if fp.suffix.lower() != ".pdf":
        with Image.open(fp) as im:
            if im.width * im.height > MAX_SOURCE_PIXELS:
                raise ValueError("image exceeds the pixel limit")
            if start != 1:
                raise ValueError("image has only one page")
            return 1, [encode(ImageOps.exif_transpose(im))]

    import pymupdf

    with pymupdf.open(fp) as doc:
        if doc.needs_pass:
            raise ValueError("PDF requires a password")
        if not 1 <= start <= len(doc):
            raise ValueError(f"page outside document (total {len(doc)})")
        frames = []
        for index in range(start - 1, min(len(doc), start - 1 + limit)):
            page = doc[index]
            edge = max(page.rect.width, page.rect.height)
            if not math.isfinite(edge) or edge <= 0:
                raise ValueError("invalid page dimensions")
            scale = min(2.5, EDGE / edge)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
            frames.append(encode(Image.frombytes("RGB", (pix.width, pix.height), pix.samples)))
        return len(doc), frames


if __name__ == "__main__":
    try:
        if os.name == "posix":
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (768 << 20, 768 << 20))
        total, frames = render(Path(sys.argv[1]), int(sys.argv[2]), min(3, max(1, int(sys.argv[3]))))
        print(json.dumps({"total": total, "frames": frames}))
    except Exception as error:
        print(json.dumps({"error": str(error)[:200]}))
