# Credits

## thinking-orbs (MIT)

The canvas thinking-orb engine in `third-party/thinking-orbs/` is a small fork of
[RareFormLabs/thinking-orbs](https://github.com/RareFormLabs/thinking-orbs) by Jakub Antalik, MIT licence.
The upstream `LICENSE` is retained verbatim at `third-party/thinking-orbs/LICENSE`.

Provenance and changes: the upstream licence file was fetched from the repository, but the engine source was
vendored from the Bridge design canvas (`Orb.dc.html`), which is itself a canvas port of thinking-orbs with the
tuned presets kept as shipped. The fork differs from upstream in that it is a plain module and the painter tints
dots in a caller-supplied colour (upstream is monochrome with no colour prop). It was not diffed line by line
against the current upstream source.

## Other

- JS Mastery's jsm-hq (MIT): reference for sandbox and approval ideas (see README).
- Matt Pocock's skills: used as installed to drive the lead pipeline and workers; not redistributed.
