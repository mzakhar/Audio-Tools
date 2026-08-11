# Theming readiness

## Done

- Semantic renderer tokens remain in `style.css`; dark and light overrides use `html[data-theme]`.
- Theme choice persists in `localStorage` and emits `themechange` for canvas or future UI consumers.
- Runtime geometry and data colors stay inline CSS variables.

## Tailwind path

- Map semantic CSS variables to Tailwind colors when Tailwind is introduced.
- Keep rack/native-control/canvas state CSS outside utility conversion.
