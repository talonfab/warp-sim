import { SEQ_RAMP } from '../lib/colors';

interface Props {
  title: string;
  note?: string;
}

export default function Legend({ title, note }: Props) {
  return (
    <div className="legend">
      <div className="legend-title">{title}</div>
      <div className="legend-scale">
        <span>flat</span>
        <div
          className="legend-gradient"
          style={{ background: `linear-gradient(to right, ${SEQ_RAMP.join(', ')})` }}
        />
        <span>lifts</span>
      </div>
      {note && <div className="legend-note">{note}</div>}
    </div>
  );
}
