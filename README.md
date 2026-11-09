# Web Annotation · Highlight & Annotate

<img src="icons/icon-128.png" width="96" alt="Web Annotation">

Highlight text on any web page, add notes and tags. Annotations are organized by site, searchable, and exportable to Markdown.

[中文说明](README-zh.md)

## Features

- Hold the modifier key and select text to highlight, in six colors
- Pick a color from the context menu
- Add a note and tags to each annotation
- Side panel lists the annotations on the current page; click one to locate it
- Manager groups annotations by site and page, with search, tag and color filters, and bulk delete
- Create folders to organize sites; new annotations file into a default folder automatically
- Export Markdown, optionally including notes, tags, colors and dates
- Full JSON backup and restore
- Chinese / English interface

## Requirements

Chrome 114 or later. No build step, no dependencies.

## Installation

1. Download `web-annotation-0.1.0.zip` from [Releases](../../releases) and unzip it
2. Open `chrome://extensions` and enable Developer mode
3. Click **Load unpacked** and select the unzipped directory

From source: clone the repository and select the directory containing `manifest.json` in step 3.

## Usage

| Action | Result |
|---|---|
| `Ctrl` + select text (`Cmd` on macOS) | Highlight with the default color |
| Right-click → Annotate selection | Choose a color |
| Click an existing highlight | Change color, add a note or tags, delete |
| Click the toolbar icon | Open the side panel |

The modifier key, trigger mode and default color are configurable in Settings. Auto-highlighting can be turned off to use the context menu only.

## Data

Annotations live in the extension's IndexedDB and survive clearing browser data. They are lost when the extension is removed or the browser profile changes, so export a JSON backup from Settings periodically.

## License

MIT, see [LICENSE](LICENSE).
