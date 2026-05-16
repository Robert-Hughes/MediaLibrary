"""
Rebuild logo.png / icon.png with a transparency mask that suits a dark
background.

The originals were rasterised onto a white background and exported with
the alpha-edge AA pre-multiplied against white.  On a dark canvas this
shows up as a bright halo around the icon (and around individual
strokes inside the artwork).

Both files share the same root cause but expose it differently:

  - icon.png  — partial-alpha edges already exist (256 alpha levels),
                but the colour channels are pre-multiplied against
                white.  We un-multiply white out of the colour while
                keeping the existing alpha.
  - logo.png  — binary alpha (every visible pixel is alpha=255).  The
                AA edge is encoded as alpha=255, near-white colour.
                We detect "halo" pixels (alpha-edge + near-white +
                a darker neighbour within 2 px) and replace their
                alpha with `(255 - lightness) * 1.5`, fading them out
                while leaving the white wordmark text alone (it has
                no darker neighbour to mark it as halo).

Run from repo root:  py tools/fix_logo_transparency.py
"""
from PIL import Image
from pathlib import Path


HALO_LIGHTNESS = 230
BODY_LIGHTNESS = 170
NEIGHBOUR_RADIUS = 2


def unmultiply_white_partial(im: Image.Image) -> Image.Image:
    """
    For each pixel with 0 < alpha < 255, recover the original colour
    from a pixel that was composited over white:

        visible = alpha * src + (1 - alpha) * white
        src     = (visible - (1 - alpha) * white) / alpha

    Pixels with alpha == 0 or alpha == 255 are unchanged.
    """
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0 or a == 255:
                continue
            af = a / 255.0
            nr = (r - (1 - af) * 255) / af
            ng = (g - (1 - af) * 255) / af
            nb = (b - (1 - af) * 255) / af
            px[x, y] = (
                max(0, min(255, int(round(nr)))),
                max(0, min(255, int(round(ng)))),
                max(0, min(255, int(round(nb)))),
                a,
            )
    return im


def fix_white_halo_binary(im: Image.Image) -> Image.Image:
    """Logo.png path: binary alpha, near-white halo as alpha=255."""
    im = im.convert("RGBA")
    src = im.load()
    w, h = im.size

    def light_at(x: int, y: int) -> int:
        if x < 0 or x >= w or y < 0 or y >= h:
            return -1
        r, g, b, a = src[x, y]
        if a == 0:
            return -1
        return max(r, g, b)

    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dst = out.load()

    for y in range(h):
        for x in range(w):
            r, g, b, a = src[x, y]
            if a == 0:
                continue

            edge = False
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1),
                           (-1, -1), (1, -1), (-1, 1), (1, 1)):
                nx, ny = x + dx, y + dy
                if nx < 0 or nx >= w or ny < 0 or ny >= h or src[nx, ny][3] == 0:
                    edge = True
                    break

            if not edge:
                dst[x, y] = (r, g, b, a)
                continue

            light = max(r, g, b)
            if light < HALO_LIGHTNESS:
                dst[x, y] = (r, g, b, a)
                continue

            has_darker = False
            for dx in range(-NEIGHBOUR_RADIUS, NEIGHBOUR_RADIUS + 1):
                for dy in range(-NEIGHBOUR_RADIUS, NEIGHBOUR_RADIUS + 1):
                    if dx == 0 and dy == 0:
                        continue
                    nl = light_at(x + dx, y + dy)
                    if 0 <= nl <= BODY_LIGHTNESS:
                        has_darker = True
                        break
                if has_darker:
                    break

            if not has_darker:
                # Standalone bright stroke (wordmark text) — keep as-is.
                dst[x, y] = (r, g, b, a)
                continue

            new_a = max(0, min(255, int(round((255 - light) * 1.5))))
            if new_a > 0:
                dst[x, y] = (r, g, b, new_a)

    return out


def process_icon(src_path: Path, out_path: Path) -> None:
    im = Image.open(src_path).convert("RGBA")
    im = unmultiply_white_partial(im)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path, format="PNG", optimize=True)
    print(f"wrote {out_path} ({im.size[0]}x{im.size[1]})")


def process_logo(src_path: Path, out_path: Path) -> None:
    im = Image.open(src_path).convert("RGBA")
    im = fix_white_halo_binary(im)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path, format="PNG", optimize=True)
    print(f"wrote {out_path} ({im.size[0]}x{im.size[1]})")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    process_icon(root / "public" / "icon.png.bak", root / "public" / "icon.png")
    process_logo(root / "public" / "logo.png.bak", root / "public" / "logo.png")
