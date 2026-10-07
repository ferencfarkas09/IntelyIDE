# dmgbuild settings for the IntelyIDE installer ((design notes: release-packaging-spec) 5.3). Loaded by make-dmg.sh with
#   dmgbuild -s settings.py -D stage=<dir> "IntelyIDE" <out.dmg>
# The stage dir holds IntelyIDE.app, background.tiff, volume.icns and .legal/ (see make-dmg.sh).
#
# Window arithmetic: Finder's WindowBounds is the OUTER window frame. With toolbar, status bar, path bar and
# sidebar hidden only the title bar remains (28 pt), so content 660x400 => outer 660x(400+28) = 660x428.
# dmgbuild writes window_rect verbatim into the .DS_Store `bwsp` WindowBounds "{{x, y}, {w, h}}".
stage = defines["stage"]  # noqa: F821  (injected by dmgbuild -D)

CONTENT_W, CONTENT_H, TITLEBAR = 660, 400, 28

format = "UDZO"
compression_level = 9
filesystem = "HFS+"

files = [(f"{stage}/IntelyIDE.app", "IntelyIDE.app"), (f"{stage}/.legal", ".legal")]
symlinks = {"Applications": "/Applications"}
hide = [".legal"]  # SetFile -a V; dot-names are hidden by Finder anyway
icon = f"{stage}/volume.icns"  # copied to .VolumeIcon.icns, custom-icon flag set on the volume
background = f"{stage}/background.tiff"  # multi-resolution TIFF (660x400 @1x + 1320x800 @2x)

window_rect = ((200, 120), (CONTENT_W, CONTENT_H + TITLEBAR))
default_view = "icon-view"
show_icon_preview = False
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
sidebar_width = 180
arrange_by = None
icon_size = 128
text_size = 13
label_pos = "bottom"
icon_locations = {"IntelyIDE.app": (165, 185), "Applications": (495, 185)}
