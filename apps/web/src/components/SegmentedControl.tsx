interface Props<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/** docs/02 §8 SegmentedControl — m/ft toggle, 2D/3D toggle. */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel }: Props<T>) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
