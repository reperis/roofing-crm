import { useState } from 'react';

import { Markdown } from '../components/Markdown';
import { resolveApiBase } from '../data/config';

/**
 * Natural-language lead research.
 *
 * The tool calls are shown alongside the answer, not hidden. An agent over a dataset where four
 * of the signals are generated has to be auditable: a rep should be able to see that "roofs over
 * fifteen years within five miles of West Chester" is exactly the filter that produced the list,
 * rather than take the prose on trust.
 */

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

interface AgentReply {
  answer: string;
  toolCalls: ToolCall[];
  rows: Record<string, unknown>[];
  totalMatches: number | null;
  budget?: { used: number; limit: number };
}

/** Render whatever columns the tool happened to return, rather than a fixed schema. */
function EvidenceTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column.replace(/_/g, ' ')}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => {
                const value = row[column];
                const generated = column === 'provenance' && value === 'synthetic';
                return (
                  <td key={column} className={generated ? 'value--generated' : undefined}>
                    {value === null || value === undefined ? (
                      <span className="muted">—</span>
                    ) : (
                      String(value)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EXAMPLES = [
  'Show me open roofing permits older than five years within five miles of West Chester.',
  'Which properties near West Chester have roofs older than 20 years and an absentee owner?',
  'Who are the worst-rated contractors with long-open permits, and where are their jobs?',
  'How reliable is this data? What is sourced and what is generated?',
  "What's in my pipeline right now?",
];

export function Ask() {
  const [question, setQuestion] = useState('');
  const [reply, setReply] = useState<AgentReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async (asked: string) => {
    if (asked.trim().length < 3) return;

    setBusy(true);
    setError(null);
    setReply(null);

    try {
      const response = await fetch(`${resolveApiBase()}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: asked }),
      });

      const body = (await response.json()) as AgentReply & { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `Request failed (${response.status})`);
      }
      setReply(body);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>Ask about the territory</h2>
        <p className="card__lede">
          Ask in plain English. The assistant searches the same Chester County records the map uses,
          reads your pipeline, and can add a property to it. It answers only from what the data
          actually says — and tells you when a value is generated rather than sourced.
        </p>

        <form
          className="ask"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(question);
          }}
        >
          <input
            className="ask__input"
            type="text"
            value={question}
            placeholder="e.g. open roofing permits older than five years near West Chester"
            maxLength={500}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button className="button" type="submit" disabled={busy || question.trim().length < 3}>
            {busy ? 'Thinking…' : 'Ask'}
          </button>
        </form>

        <div className="examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => {
                setQuestion(example);
                void ask(example);
              }}
            >
              {example}
            </button>
          ))}
        </div>
      </section>

      {error !== null && (
        <section className="card">
          <p className="status status--error" role="alert">
            {error}
          </p>
        </section>
      )}

      {reply !== null && (
        <section className="card">
          <h2>Answer</h2>
          {/*
            Rendered, not printed. The model writes bold lead sentences and bulleted findings, and
            a rep reading literal **asterisks** is reading a defect.
          */}
          <div className="answer">
            <Markdown text={reply.answer} />
          </div>

          {reply.toolCalls.length > 0 && (
            <details className="trace">
              <summary>
                {reply.toolCalls.length} data lookup{reply.toolCalls.length === 1 ? '' : 's'} — show
                what was searched
              </summary>
              <ul className="trace__list">
                {reply.toolCalls.map((call, index) => (
                  <li key={`${call.tool}-${index}`}>
                    <span className="mono">{call.tool}</span>
                    <span className="trace__args mono">{JSON.stringify(call.input)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {reply.rows.length > 0 && (
            <>
              <p className="muted">
                {reply.totalMatches !== null && reply.totalMatches > reply.rows.length
                  ? `${reply.totalMatches.toLocaleString('en-US')} matched; showing the ${reply.rows.length} the assistant read.`
                  : `${reply.rows.length} record${reply.rows.length === 1 ? '' : 's'} the assistant read.`}
              </p>
              <EvidenceTable rows={reply.rows} />
            </>
          )}

          {reply.budget !== undefined && (
            <p className="muted">
              {reply.budget.used} of {reply.budget.limit} assistant questions used today.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
