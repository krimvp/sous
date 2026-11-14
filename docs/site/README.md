# Landing page

`site/index.html` is the published page, <https://krimvp.github.io/sous/>. It is one self-contained HTML file.

- [COPY.md](COPY.md) holds the page text in page order, with the source of each fact in the code or the docs.

To change the page:

1. Change the text in COPY.md.
2. Make the same change in `site/index.html`.
3. Open the page in a browser and examine it at desktop and phone widths.
4. Make sure that each claim agrees with the code and with [docs/design.md](../design.md).
5. Run `scripts/publish-site.sh`. It commits `site/` to the `gh-pages` branch, and GitHub Pages serves it.
