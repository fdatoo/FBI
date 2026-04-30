/**
 * Small inline SVG icons sized for sidebar/status-bar use. Single-color,
 * inherits `currentColor`. Keep the set minimal — add new icons only when a
 * feature needs one, not preemptively.
 */
interface IconProps {
  size?: number;
  className?: string;
  'aria-label'?: string;
}

function svgProps({ size = 16, className, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': rest['aria-label'] ? undefined : true,
    className,
    ...rest,
  } as const;
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4.5 3 L12 8 L4.5 13 Z" fill="currentColor" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      {/* Bootstrap Icons gear-fill — fill-based, renders cleanly at any size */}
      <path
        fill="currentColor"
        d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"
      />
    </svg>
  );
}
