import { useState } from 'react';

import { Dataset } from './views/Dataset';
import { Prospect } from './views/Prospect';

/** Injected by Vite at build time; see `define` in vite.config.ts. */
declare const __BUILD_TIME__: string;

const TABS = [
  { id: 'prospect', label: 'Prospect', render: () => <Prospect /> },
  { id: 'dataset', label: 'Dataset', render: () => <Dataset /> },
] as const;

type TabId = (typeof TABS)[number]['id'];

/**
 * Where this product goes after lead identification.
 *
 * Shown disabled rather than hidden, which the story asks for explicitly. It is also the honest
 * way to present scope: a roofing company evaluating this can see that the shape of the full CRM
 * was considered and that lead identification was cut out of it deliberately, rather than
 * wondering whether the rest was simply forgotten.
 */
const PLANNED_TABS = [
  { id: 'estimates', label: 'Estimates', note: 'Measure-to-quote from roof geometry' },
  { id: 'jobs', label: 'Jobs', note: 'Scheduling and crew assignment once a quote is accepted' },
  { id: 'invoicing', label: 'Invoicing', note: 'Progress billing and insurance claim packets' },
  { id: 'outreach', label: 'Outreach', note: 'Door-knock routes, mail merge and call logging' },
] as const;

export function App() {
  const [active, setActive] = useState<TabId>('prospect');
  const current = TABS.find((tab) => tab.id === active) ?? TABS[0];

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead__title">
          <span className="masthead__mark">▲</span>
          <div>
            <h1>Roofing CRM — Chester County</h1>
            <p>Find, qualify and work residential roofing leads in Chester County, Pennsylvania</p>
          </div>
        </div>

        <nav className="tabs" aria-label="Sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`tab ${tab.id === active ? 'tab--active' : ''}`}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          ))}

          <span className="tabs__divider" aria-hidden="true" />

          {PLANNED_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="tab tab--planned"
              disabled
              title={`Planned — ${tab.note}. Out of scope for the lead-identification milestone.`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <main>{current.render()}</main>

      <footer className="footer">
        <span>
          Parcel and permit records © Chester County, Pennsylvania · published by the Oracle
          pipeline · queried in-browser with DuckDB
        </span>
        <span className="footer__stamp">Build {__BUILD_TIME__}</span>
      </footer>
    </div>
  );
}
