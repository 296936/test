# Archived VCard skin assets

These files are retained as design-source material only. The template runtime
is fixed to `data-skin="none"`, does not create skin layers, and no longer
offers B1/B2/B3 in settings.

Selectable `v6` player and portal frames use the same eight `128x128` PNG parts:
`tl`, `t`, `tr`, `r`, `br`, `b`, `bl`, and `l`. Player and portal copies within
one skin version must remain byte-identical so the visible rail has the same
weight on both objects.

Each PNG is a packed two-tone luminance mask:

- red: the large base material, tinted with the page's muted/body color;
- green: darker inset detail, tinted with `--vc-acc`;
- blue: unused and set to zero.

The channel values include the material luminance and former alpha coverage.
Black pixels become transparent in the `#vc-skin-duotone` SVG filter. Do not
grayscale these files at runtime: doing so merges the two masks and destroys the
duotone design.

The `v6` parts retain the enlarged `v5` geometry. Their masks are mutually
exclusive: a pixel belongs to the base material or to the accent detail, never
both. The continuous rails belong to the base material. Only the recessed
corner hardware uses the accent channel, at 80% luminance, so the second color
is visible without becoming a continuous outline around the photograph. All
three visible profiles remain about 50% heavier than `v4`; their different
masses remain intentional.

At runtime both kinds use a 30 CSS-pixel corner cell. The player and portal
reserve their own inner gutters, so the physical shell expands the outer box
instead of covering the former control or photograph area. Horizontal and
vertical rails have different depths, so portal gutters are measured per axis:
15x14px for `cassette-cyan-v6`, 13x11px for `smoked-slide-v6`, and 20x16px for
`metal-cyan-v6` at the 30px portal base.

The `v1` through `v5` folders are retained as source/reference assets. They are
not offered in settings; stored selections migrate to their corresponding `v6`
names.

Each selectable player folder also contains a `2048x96` packed `guide.png`.
It is a complete generated inner playlist rail rather than a CSS assembly:
the base channel contains the continuous material and its two transparent end
fades, while the accent channel contains five recessed cross-head fasteners.
The lower rail reuses the same image reflected vertically.
