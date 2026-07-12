import { PlateResult } from '../lib/plateSim';
import { riskColorCss, STATUS } from '../lib/colors';

interface Props {
  results: PlateResult[];
  activeId: string;
  onSelect: (id: string) => void;
}

export default function ResultsTable({ results, activeId, onSelect }: Props) {
  if (results.length === 0) {
    return <p className="fine">Select at least one filament to compare.</p>;
  }
  return (
    <section className="results">
      <h2>Warp likelihood by filament</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Filament</th>
            <th scope="col">Risk</th>
            <th scope="col" className="num">Score</th>
            <th scope="col" className="num">Bed °C</th>
            <th scope="col" className="num">Chamber °C</th>
            <th scope="col">Key advice</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const status = STATUS[r.bucket];
            return (
              <tr
                key={r.filament.id}
                className={r.filament.id === activeId ? 'active' : ''}
                onClick={() => onSelect(r.filament.id)}
                title="Click to show this filament's heatmap"
              >
                <th scope="row">{r.filament.name}</th>
                <td>
                  <span className="badge" style={{ borderColor: status.color }}>
                    <span aria-hidden="true" style={{ color: status.color }}>
                      {status.icon}
                    </span>{' '}
                    {status.label}
                  </span>
                </td>
                <td className="num">
                  <div className="scorebar" aria-label={`score ${r.score} of 100`}>
                    <div
                      className="scorebar-fill"
                      style={{ width: `${r.score}%`, background: riskColorCss(r.score / 100) }}
                    />
                  </div>
                  {r.score}
                </td>
                <td className="num">{r.bedTemp}</td>
                <td className="num">{r.chamberTemp}</td>
                <td className="advice">{r.recommendations[0]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="fine">
        Scores compare filaments on this part under the shown conditions. Click a row to paint its
        risk field on the model.
      </p>
    </section>
  );
}
