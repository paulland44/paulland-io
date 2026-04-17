# Icon Library

A curated collection of open-source SVG icon sets for use in presentations, documents, and web projects.

## Contents

| Set | Icons | Style | License | Source |
|-----|-------|-------|---------|--------|
| **Heroicons** | 972 | Outline, Solid, Mini | MIT | [tailwindlabs/heroicons](https://github.com/tailwindlabs/heroicons) |
| **Bootstrap Icons** | 2,078 | Filled + Outlined | MIT | [twbs/icons](https://github.com/twbs/icons) |
| **Font Awesome** | 2,860 | Solid, Regular, Brands | CC BY 4.0 / OFL / MIT | [FortAwesome/Font-Awesome](https://github.com/FortAwesome/Font-Awesome) |
| **Lucide** | 1,695 | Outline (stroke-based) | ISC | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) |
| **Total** | **7,605** | | | |

## Directory Structure

```
icons/
├── by-topic/             # Symlinked icons organised by theme
│   ├── production-manufacturing/
│   ├── automation-workflows/
│   ├── data-analytics/
│   ├── packaging-print/
│   ├── strategy-business/
│   ├── technology-cloud/
│   ├── common-ui-navigation/
│   ├── people-communication/
│   ├── ai-machine-learning/
│   ├── documents-files/
│   ├── finance-sales/
│   ├── security-compliance/
│   ├── time-scheduling/
│   ├── status-alerts/
│   └── social-brands/
├── heroicons/
│   ├── outline/      # 24px outline style (most versatile)
│   ├── solid/        # 24px filled style
│   └── mini/         # 20px compact solid
├── bootstrap/        # All styles in one directory
├── fontawesome/
│   ├── solid/        # Filled icons
│   ├── regular/      # Outlined icons
│   └── brands/       # Company/product logos
└── lucide/           # Stroke-based outline icons
```

### Browse by Topic

The `by-topic/` directory contains **symlinks** to icons in the original set folders, organised by presentation theme. Each symlink uses a descriptive concept name (e.g. `factory.svg`, `robot.svg`) and points back to the original file. The originals are never duplicated.

Open `by-topic/` in Finder and browse by category to quickly find the right icon for a slide or document. See [TOPICS.md](TOPICS.md) for the full catalogue with 15 categories.

## Browsing Icons

Each set has a searchable website for finding icons by keyword:

- **Heroicons**: [heroicons.com](https://heroicons.com)
- **Bootstrap Icons**: [icons.getbootstrap.com](https://icons.getbootstrap.com)
- **Font Awesome**: [fontawesome.com/icons](https://fontawesome.com/icons)
- **Lucide**: [lucide.dev/icons](https://lucide.dev/icons)

See [TOPICS.md](TOPICS.md) for a topic-based catalogue mapped to common presentation themes.

## Usage

### Recolouring SVGs

Open the `.svg` file in a text editor and change the `fill` or `stroke` attribute:

```xml
<!-- Change fill for solid icons -->
<path fill="#028090" d="..."/>

<!-- Change stroke for outline icons (Heroicons, Lucide) -->
<path stroke="#028090" stroke-width="1.5" d="..."/>
```

### In Presentations

SVGs can be inserted directly into PowerPoint, Keynote, and Google Slides. If an application doesn't support SVG, convert to PNG first:

```bash
# Using Inkscape CLI
inkscape icon.svg --export-type=png --export-width=256 -o icon.png

# Using ImageMagick
convert -background none -resize 256x256 icon.svg icon.png
```

### Consistent Style

For visual consistency across a deck, stick to **one icon set** and **one style** (e.g. Heroicons outline only). Mixing sets with different stroke weights or fill approaches looks inconsistent.

## Updating

These icons were pulled from the source repos. To update to the latest versions:

```bash
# Example for Heroicons
git clone --depth 1 https://github.com/tailwindlabs/heroicons.git /tmp/heroicons
cp /tmp/heroicons/optimized/24/outline/*.svg icons/heroicons/outline/
cp /tmp/heroicons/optimized/24/solid/*.svg icons/heroicons/solid/
cp /tmp/heroicons/optimized/20/solid/*.svg icons/heroicons/mini/
rm -rf /tmp/heroicons
```

## Licensing

Each icon set retains its original license — see the `LICENSE` file within each directory. All sets permit free use in commercial and personal projects with attribution.
