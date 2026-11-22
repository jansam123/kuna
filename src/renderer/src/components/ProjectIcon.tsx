/**
 * Project icons: line drawings on a 24 grid, drawn in the project's colour
 * (`currentColor`). A name that is not in the set is shown as text, so any
 * letter works as an icon too: μ, γ, H, an emoji.
 */
const wave = 'q1 -2.6 2 0 t2 0 t2 0 t2 0'

export const ICONS: Record<string, React.ReactNode> = {
  // ---- particle physics
  collision: (
    <>
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <path d="M12 12Q15 8 20.5 6.5M12 12Q8 9.5 4.5 4.5M12 12Q9 15.5 3.5 17M12 12Q14.5 16 13.5 21.5M12 12Q16.5 13 20.5 16" />
    </>
  ),
  detector: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="12" r="5.5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <path d="M12 12Q15.5 9.5 18.7 5.3" />
    </>
  ),
  tracker: (
    <>
      <path d="M9 21A6 6 0 0 0 3 15M14.5 21A11.5 11.5 0 0 0 3 9.5M20 21A17 17 0 0 0 3 4" />
      <path d="M3 21L18.5 5" strokeDasharray="0.1 4.1" strokeWidth="3.4" />
    </>
  ),
  feynman: <path d={`M3 5L8 12L3 19M21 5L16 12L21 19M8 12${wave}`} />,
  loop: (
    <>
      <path d="M2 6.5H8L16.5 12L8 17.5H2M8 6.5V17.5" />
      <path d="M16.5 12H22" strokeDasharray="1.6 2.4" />
    </>
  ),
  photon: <path d="M2 12q1.67 -6 3.33 0t3.33 0t3.33 0t3.33 0t3.33 0t3.33 0" />,
  gluon: <path d="M1.5 15H4.5c5 0 5 -8 2 -8s-3 8 2 8s5 -8 2 -8s-3 8 2 8s5 -8 2 -8s-3 8 2 8H22.5" />,
  higgs: (
    <>
      <path d="M2.5 6C5 27 9 11 12 11C15 11 19 27 21.5 6" />
      <circle cx="12" cy="7.2" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  peak: <path d="M3 3V21H21M3 9H6.6V13H10.2V5H13.8V15H17.4V18H21" />,
  limit: (
    <>
      <path d="M3 3V21H21M5.5 8.5C9 15 14 16.5 21 17" />
      <path d="M5.5 4C10 11.5 15 13 21 13.5" strokeDasharray="1.5 2.6" />
    </>
  ),
  jet: <path d="M4 20L8.5 3.5M4 20L15 4.5M4 20L20 10M4 20L20.5 16.5" />,
  shower: <path d="M12 2V7L8 12L5.5 17L4.8 21.5M12 7L16 12L18.5 17L19.2 21.5M8 12L10 17V21.5M16 12L14 17V21.5" />,
  spiral: <path d="M12 12a1.5 1.5 0 0 1 3 0a3 3 0 0 1 -6 0a4.5 4.5 0 0 1 9 0a6 6 0 0 1 -12 0a7.5 7.5 0 0 1 15 0V3" />,
  ring: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5h.01M20.5 12h.01M12 20.5h.01M3.5 12h.01" strokeWidth="4.4" />
    </>
  ),
  magnet: <path d="M6 3V13A6 6 0 0 0 18 13V3H14V13A2 2 0 0 1 10 13V3ZM6 7.5H10M14 7.5H18" />,
  atom: (
    <>
      <ellipse cx="12" cy="12" rx="10" ry="3.9" />
      <ellipse cx="12" cy="12" rx="10" ry="3.9" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="3.9" transform="rotate(120 12 12)" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  triangle: <path d="M3 19H21L9.5 5ZM7.6 19A4.6 4.6 0 0 0 5.9 15.5" />,
  network: (
    <>
      <path d="M5 7L12 7L19 12L12 17L5 17M5 7L12 17M5 17L12 7" strokeWidth="1.2" />
      <path d="M5 7h.01M5 17h.01M12 7h.01M12 17h.01M19 12h.01" strokeWidth="4.6" />
    </>
  ),
  matrix: (
    <>
      <path d="M10 3.5h4v4h-4zM16.5 3.5h4v4h-4zM3.5 10h4v4h-4zM16.5 10h4v4h-4zM3.5 16.5h4v4h-4zM10 16.5h4v4h-4z" strokeWidth="1.3" />
      <path d="M3.5 3.5h4v4h-4zM10 10h4v4h-4zM16.5 16.5h4v4h-4z" fill="currentColor" strokeWidth="1.3" />
    </>
  ),
  dice: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" strokeWidth="2.8" />
    </>
  ),
  vertex: <path d="M3 5L10 12L3 19M10 12q1.375 -2.6 2.75 0t2.75 0t2.75 0t2.75 0" />,
  penguin: <path d="M2 8H22M7 8A5 5 0 0 0 17 8M12 13q-2.2 1.1 0 2.2t0 2.2t0 2.2t0 2.2" />,
  box: <path d="M8 8H16V16H8ZM3 4.5L8 8M21 4.5L16 8M3 19.5L8 16M21 19.5L16 16" />,
  decay: <path d="M2.5 12H11L21 5M11 12H21M11 12L21 19" />,
  beams: (
    <>
      <path d="M2 12H8.5M5.5 9L8.5 12L5.5 15M22 12H15.5M18.5 9L15.5 12L18.5 15" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  hadron: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7.5h.01M8 14.5h.01M16 14.5h.01" strokeWidth="4.4" />
    </>
  ),
  nucleus: (
    <>
      <circle cx="12" cy="7.6" r="3.7" />
      <circle cx="7.8" cy="15" r="3.7" fill="currentColor" />
      <circle cx="16.2" cy="15" r="3.7" />
    </>
  ),
  pair: (
    <>
      <circle cx="7" cy="12" r="4.7" />
      <circle cx="17" cy="12" r="4.7" />
      <path d="M7 9.8V14.2M4.8 12H9.2M14.8 12H19.2" strokeWidth="1.5" />
    </>
  ),
  spin: (
    <>
      <path d="M12 21.5V2.5M8.5 6L12 2.5L15.5 6" />
      <ellipse cx="12" cy="13.5" rx="8" ry="3" />
    </>
  ),
  oscillation: (
    <>
      <path d="M2 12q2.5 -9 5 0t5 0t5 0t5 0" />
      <path d="M2 12q2.5 9 5 0t5 0t5 0t5 0" strokeDasharray="1.5 2.6" />
    </>
  ),
  cherenkov: (
    <>
      <circle cx="12" cy="12" r="8" strokeWidth="2.9" strokeDasharray="0.1 4.089" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  towers: <path d="M4.5 20V14M9.5 20V8M14.5 20V4M19.5 20V11" strokeWidth="3" />,
  pulse: <path d="M2 17H6.5V7H11.5V17H16.5V11.5H22" />,
  lattice: (
    <>
      <path d="M5 5H19V19H5ZM12 5V19M5 12H19" strokeWidth="1.2" />
      <path d="M5 5h.01M12 5h.01M19 5h.01M5 12h.01M12 12h.01M19 12h.01M5 19h.01M12 19h.01M19 19h.01" strokeWidth="3.8" />
    </>
  ),
  galaxy: (
    <>
      <path d="M12 12C12 8 15 5.5 19 6.5M12 12C12 16 9 18.5 5 17.5M12 12C16 12 18.5 15 17.5 19M12 12C8 12 5.5 9 6.5 5" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  bell: (
    <>
      <path d="M2 19C8 19 8.5 5 12 5C15.5 5 16 19 22 19" />
      <path d="M12 8.5V19" strokeDasharray="1.5 2.6" />
    </>
  ),
  data: (
    <>
      <path d="M6 9V17M4.3 9H7.7M4.3 17H7.7M12 4V12M10.3 4H13.7M10.3 12H13.7M18 10V18M16.3 10H19.7M16.3 18H19.7" strokeWidth="1.5" />
      <path d="M6 13h.01M12 8h.01M18 14h.01" strokeWidth="4" />
    </>
  ),
  contour: (
    <>
      <path d="M3 3V21H21" />
      <ellipse cx="13" cy="11" rx="7.5" ry="4.2" transform="rotate(-28 13 11)" />
      <ellipse cx="13" cy="11" rx="3.2" ry="1.6" transform="rotate(-28 13 11)" />
    </>
  ),
  roc: (
    <>
      <path d="M3 3V21H21M3 21C4 10 9 4.5 21 3" />
      <path d="M3 21L21 3" strokeDasharray="1.5 2.6" />
    </>
  ),
  cutflow: <path d="M3 4.5H21L14.2 12.5V20L9.8 17.8V12.5Z" />,
  gauge: (
    <>
      <path d="M3.5 17A8.5 8.5 0 0 1 20.5 17M12 17L16.5 9.5" />
      <path d="M12 17h.01" strokeWidth="3.8" />
    </>
  ),
  // ---- everything else
  plot: <path d="M3 3V21H21M6.5 16L10.5 11L14 14L20 6" />,
  paper: <path d="M6 3H14L19 8V21H6ZM14 3V8H19M9 13H16M9 17H16" />,
  book: <path d="M12 6.5C10 4.8 7 4.3 3.5 5V19C7 18.3 10 18.8 12 20.5C14 18.8 17 18.3 20.5 19V5C17 4.3 14 4.8 12 6.5ZM12 6.5V20.5" />,
  thesis: <path d="M2 9L12 4L22 9L12 14ZM6 11.3V16.5C8 19.2 16 19.2 18 16.5V11.3M22 9V15" />,
  code: <path d="M8 7L3 12L8 17M16 7L21 12L16 17M13.7 5L10.3 19" />,
  terminal: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="3" />
      <path d="M6.5 9.5L10 12L6.5 14.5M12.5 15H17" />
    </>
  ),
  cluster: (
    <>
      <rect x="3" y="3.5" width="18" height="7" rx="2" />
      <rect x="3" y="13.5" width="18" height="7" rx="2" />
      <path d="M7 7h.01M7 17h.01" strokeWidth="2.6" />
      <path d="M12 7H17M12 17H17" />
    </>
  ),
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="10" y="10" width="4" height="4" rx="0.5" />
      <path d="M9 2.5V6M15 2.5V6M9 18V21.5M15 18V21.5M2.5 9H6M2.5 15H6M18 9H21.5M18 15H21.5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6V18A8 3 0 0 0 20 18V6M4 12A8 3 0 0 0 20 12" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <ellipse cx="12" cy="12" rx="4" ry="9.5" />
      <path d="M2.5 12H21.5" />
    </>
  ),
  flask: <path d="M9 3H15M10 3V9L4.6 18.6A1.6 1.6 0 0 0 6 21H18A1.6 1.6 0 0 0 19.4 18.6L14 9V3M7.4 15H16.6" />,
  bolt: <path d="M13 2.5L5 13.5H11L10 21.5L19 10H13Z" />,
  star: <path d="M12 3l2.7 5.6l6.1 .8l-4.5 4.3l1.1 6.1l-5.4 -2.9l-5.4 2.9l1.1 -6.1l-4.5 -4.3l6.1 -.8z" />,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10L12 8H19.5A1.5 1.5 0 0 1 21 9.5V18.5A1.5 1.5 0 0 1 19.5 20H4.5A1.5 1.5 0 0 1 3 18.5Z" />,
  layers: <path d="M12 3.5L21 8L12 12.5L3 8ZM3.5 12L12 16.5L20.5 12M3.5 16L12 20.5L20.5 16" />,
  package: <path d="M12 3L20.5 7.5V16.5L12 21L3.5 16.5V7.5ZM3.5 7.5L12 12L20.5 7.5M12 12V21" />,
  table: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 9.5H21M3 14.5H21M9.5 4.5V19.5" />
    </>
  ),
  slides: <path d="M3 4H21M4.5 4V15.5H19.5V4M12 15.5V18.5M8 21.5L12 18.5L16 21.5M8.5 11.5L11 9L13 10.5L15.5 7.5" />,
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M3.5 17.5L9 12.5L13 16L16 13.5L20.5 17.5" />
    </>
  ),
  pencil: <path d="M4 20L5 15.5L16 4.5A2.1 2.1 0 0 1 19.5 8L8.5 19ZM14 6.5L17.5 10" />,
  branch: (
    <>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 7.2V16.8M18 10.2C18 14.5 6 12 6 16.8" />
    </>
  ),
  bug: <path d="M7 13.5A5 6.5 0 0 0 17 13.5A5 6.5 0 0 0 7 13.5M9.5 7.6A2.5 2.5 0 0 1 14.5 7.6M12 7.5V20M7.3 11L3.5 9M16.7 11L20.5 9M7 14.5H3M17 14.5H21M7.7 17.5L4 20M16.3 17.5L20 20" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="6.6" />
      <path d="M12 2.5V5M12 19V21.5M2.5 12H5M19 12H21.5M5.3 5.3L7 7M17 17L18.7 18.7M5.3 18.7L7 17M17 7L18.7 5.3" strokeWidth="2.8" />
    </>
  ),
  robot: (
    <>
      <rect x="4.5" y="8" width="15" height="11.5" rx="2.5" />
      <path d="M12 8V4.5M9.5 16.5H14.5M2.5 12.5V15.5M21.5 12.5V15.5" />
      <path d="M12 3.6h.01M9 12.5h.01M15 12.5h.01" strokeWidth="2.8" />
    </>
  ),
  chat: <path d="M5.5 4H18.5A1.5 1.5 0 0 1 20 5.5V15A1.5 1.5 0 0 1 18.5 16.5H10.5L6 20.5V16.5H5.5A1.5 1.5 0 0 1 4 15V5.5A1.5 1.5 0 0 1 5.5 4Z" />,
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3.5 7L12 13.5L20.5 7" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10H20.5M8 3V6.5M16 3V6.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 6.5V12L15.5 14.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12C5 6.5 9 5 12 5C15 5 19 6.5 22 12C19 17.5 15 19 12 19C9 19 5 17.5 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10.5" rx="2.5" />
      <path d="M8 10.5V7.5A4 4 0 0 1 16 7.5V10.5" />
      <path d="M12 15.5h.01" strokeWidth="3" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4" />
      <path d="M10.5 12.5L20 3M16.5 6.5L19 9M14 9L16 11" />
    </>
  ),
  cloud: <path d="M7 19A4.5 4.5 0 0 1 6.3 10.1A6 6 0 0 1 17.8 9.6A4.7 4.7 0 0 1 17.5 19Z" />,
  rocket: (
    <>
      <path d="M12 2.5C16 6 16.5 11 15 15H9C7.5 11 8 6 12 2.5ZM9 15L6 18.5V14M15 15L18 18.5V14M10.5 18.5L12 21.5L13.5 18.5" />
      <circle cx="12" cy="9" r="1.6" />
    </>
  ),
  flag: <path d="M5 21.5V3.5M5 4.5C9 2.5 11 6.5 19 4.5V13.5C11 15.5 9 11.5 5 13.5" />,
  home: <path d="M3.5 11L12 3.5L20.5 11M5.5 9.5V20H18.5V9.5M10 20V14.5H14V20" />,
  coffee: <path d="M4.5 9H16.5V15A5 5 0 0 1 11.5 20H9.5A5 5 0 0 1 4.5 15ZM16.5 10.5H18A2.75 2.75 0 0 1 18 16H16.3M8 3V6M12.5 3V6" />,
  music: (
    <>
      <path d="M9 18V5.5L19 3.5V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </>
  ),
  heart: <path d="M12 20.5C5 15.5 2.5 12 2.5 8.5A4.75 4.75 0 0 1 12 6.5A4.75 4.75 0 0 1 21.5 8.5C21.5 12 19 15.5 12 20.5Z" />
}

/** how many of the icons are particle physics (the picker lists them first, under their own heading) */
export const HEP_ICONS = Object.keys(ICONS).indexOf('plot')
/** particle names offered as text icons */
export const GLYPHS = ['H', 'W', 'Z', 'γ', 'g', 't', 'b', 'μ', 'τ', 'ν', 'π', 'K', 'B', 'D', 'Λ', 'Σ']

export function ProjectIcon({ icon, name }: { icon?: string; name: string }): React.JSX.Element {
  const body = icon && ICONS[icon]
  if (body) {
    return (
      <svg className="proj-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {body}
      </svg>
    )
  }
  // no icon picked: the name's first letter (skipping TeX's `$` and `\`)
  const text = icon || (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase()
  return (
    <span className={`proj-icon glyph ${icon ? '' : 'initial'}`} aria-hidden>
      {text}
    </span>
  )
}
