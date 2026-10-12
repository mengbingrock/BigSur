import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowRight,
  BookOpen,
  Check,
  FileText,
  Search,
} from "lucide-react";
import { benchmarkRows } from "~/content/benchmark";
import "./brand-home.css";

const steps = [
  {
    number: "01",
    icon: Search,
    title: "Find the evidence",
    description:
      "Search protocols and bring relevant source material into your research.",
  },
  {
    number: "02",
    icon: BookOpen,
    title: "Keep the context",
    description:
      "Work with protocols, skills, and agents in one place, with the sources close at hand.",
  },
  {
    number: "03",
    icon: FileText,
    title: "Make it your work",
    description:
      "Develop and review your protocols, then return to the work from your connected devices.",
  },
];

export function BrandHome() {
  return (
    <div className="brand-home">
      <Link className="brand-skip" to="/" hash="main-content">
        Skip to content
      </Link>
      <header className="brand-header brand-container">
        <Link to="/" className="brand-logo" aria-label="Labee home">
          <span className="brand-mark" aria-hidden="true" />
          Labee<span className="brand-logo-period">.</span>
        </Link>
        <nav aria-label="Main navigation" className="brand-nav">
          <Link to="/" hash="approach" className="brand-nav-section">
            Approach
          </Link>
          <Link to="/" hash="benchmarks">
            Benchmarks
          </Link>
          <Link
            to="/login"
            search={{ next: "/protocols" }}
            className="brand-sign-in"
          >
            Sign in <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </nav>
      </header>

      <main id="main-content">
        <section
          className="brand-hero brand-container"
          aria-labelledby="brand-title"
        >
          <div>
            <p className="brand-eyebrow">
              <span className="brand-status-dot" /> A workspace for protocol
              research
            </p>
            <h1 id="brand-title">
              Better questions.
              <br />
              Evidence in view.
              <br />
              <em>Your next discovery.</em>
            </h1>
            <p className="brand-intro">
              Bring protocols, research skills, and AI agents together. Find the
              sources, develop your ideas, and keep your work connected with
              Labee.
            </p>
            <div className="brand-actions">
              <Link
                to="/signup"
                search={{ next: "/protocols" }}
                className="brand-button"
              >
                Get started <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <Link to="/" hash="benchmarks" className="brand-text-link">
                Explore the evidence <ArrowDown size={16} aria-hidden="true" />
              </Link>
            </div>
            <p className="brand-hero-note">
              Built for the work between a question and a protocol.
            </p>
          </div>

          <div
            className="brand-research-map"
            aria-label="Research workflow: question, source protocols, review"
          >
            <div className="brand-map-heading">
              <span className="brand-eyebrow">The research workspace</span>
              <span className="brand-map-index">FIG. 01</span>
            </div>
            <div className="brand-question">
              <span className="brand-card-label">Start with a question</span>
              <p>
                What evidence supports
                <br />
                the next step?
              </p>
              <Search size={19} aria-hidden="true" />
            </div>
            <div className="brand-connector" aria-hidden="true" />
            <div className="brand-source-stack">
              <div className="brand-source-card">
                <BookOpen size={20} aria-hidden="true" />
                <div>
                  <span className="brand-card-label">Source protocols</span>
                  <p>Relevant methods. Original context.</p>
                </div>
                <span className="brand-source-dot" aria-hidden="true" />
              </div>
            </div>
            <div className="brand-connector" aria-hidden="true" />
            <div className="brand-review-card">
              <span className="brand-review-icon">
                <Check size={18} aria-hidden="true" />
              </span>
              <div>
                <span className="brand-card-label">Your workspace</span>
                <p>Read. Develop. Review.</p>
              </div>
              <span className="brand-map-index">↗</span>
            </div>
            <p className="brand-map-caption">
              Human judgment, with the evidence close by.
            </p>
          </div>
        </section>

        <section
          id="approach"
          className="brand-approach brand-container"
          aria-labelledby="approach-title"
        >
          <div className="brand-section-heading">
            <p className="brand-eyebrow">From source to next step</p>
            <h2 id="approach-title">A place for the whole process.</h2>
          </div>
          <div className="brand-steps">
            {steps.map(({ number, icon: Icon, title, description }) => (
              <article className="brand-step" key={number}>
                <div className="brand-step-top">
                  <span>{number}</span>
                  <Icon size={22} strokeWidth={1.5} aria-hidden="true" />
                </div>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          id="benchmarks"
          className="brand-benchmarks"
          aria-labelledby="benchmark-title"
        >
          <div className="brand-container">
            <div className="brand-benchmark-heading">
              <div>
                <p className="brand-eyebrow">Research in numbers</p>
                <h2 id="benchmark-title">
                  What does the
                  <br />
                  <em>evidence add?</em>
                </h2>
              </div>
              <div className="brand-benchmark-intro">
                <p>
                  We tested a plain LLM, retrieval-augmented generation, and a
                  patched BioProAgent on the same BioProBench questions.
                </p>
                <p>
                  Scores below use identical cases across all three runs,
                  excluding provider refusals in any run.
                </p>
              </div>
            </div>
            <div className="brand-study-meta" aria-label="Study setup">
              <span>
                <strong>200</strong> selected cases
              </span>
              <span>
                <strong>50</strong> per task
              </span>
              <span>
                <strong>Opus 5.5</strong> in all three runs
              </span>
            </div>
            <p className="brand-table-mobile-hint">
              Scroll across to compare all three approaches →
            </p>
            <div
              className="brand-table-scroll"
              role="region"
              aria-label="Benchmark results, horizontally scrollable on small screens"
              tabIndex={0}
            >
              <table className="brand-results">
                <caption className="sr-only">
                  BioProBench results on matched non-refused cases. Higher
                  scores are better; model calls measure inference cost.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">Matched N</th>
                    <th scope="col">No RAG</th>
                    <th scope="col">Plain RAG</th>
                    <th scope="col">Patched agent</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarkRows.map((row) => (
                    <tr key={row.metric}>
                      <th scope="row">
                        {row.metric}
                        <span>{row.detail}</span>
                      </th>
                      <td>{row.n}</td>
                      <td>{row.noRag}</td>
                      <td>{row.rag}</td>
                      <td>{row.agent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="brand-table-note">
              Matched N is the number of questions retained for each comparison.
              Total model calls include all 200 selected cases.
            </p>
            <div className="brand-finding">
              <span className="brand-eyebrow">The finding</span>
              <p>
                Retrieval’s clearest benefit is <strong>GEN</strong>. The
                accuracy differences remain uncertain at this sample size.
              </p>
            </div>
            <details className="brand-methodology">
              <summary>
                Behind the numbers <span>Methodology & limitations</span>
                <span className="brand-details-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="brand-method-grid">
                <div>
                  <h3>Three approaches</h3>
                  <p>
                    No RAG uses one model call with the official question only.
                    Plain RAG adds retrieved protocol passages. The patched
                    agent uses the same evidence with state-based planning,
                    review, and up to two revisions.
                  </p>
                </div>
                <div>
                  <h3>A controlled comparison</h3>
                  <p>
                    All runs use Opus 5.5 and the same 50 questions per task.
                    Retrieval uses Qwen3-Embedding-8B and a 60/40 semantic–BM25
                    weighting. “Patched agent” refers to our adaptation of the
                    public BioProAgent research code.
                  </p>
                </div>
                <div>
                  <h3>Read the limits</h3>
                  <p>
                    These are previously analyzed development cases, with one
                    run per approach. GEN measures token overlap, not scientific
                    correctness. This is a sampled experiment, not a
                    reproduction of the full paper’s results.
                  </p>
                </div>
              </div>
              <p className="brand-run-note">
                The no-RAG run had 30 provider refusals and no other call
                failures. Seven evaluation-harness tests passed. These checks
                validate the evaluation code, not the scientific quality of
                generated protocols.
              </p>
              <div className="brand-method-links">
                <a href="/benchmarks/bioprobench-summary.md" download>
                  Download methodology{" "}
                  <ArrowDown size={14} aria-hidden="true" />
                </a>
                <a href="https://github.com/YuyangSunshine/bioprobench">
                  BioProBench source <ArrowRight size={14} aria-hidden="true" />
                </a>
                <a href="https://github.com/YuyangSunshine/bioproagent">
                  BioProAgent source <ArrowRight size={14} aria-hidden="true" />
                </a>
              </div>
            </details>
            <p className="brand-run-summary">
              No-RAG run: 30 provider refusals · No other call failures · Seven
              evaluation-harness tests passed
            </p>
          </div>
        </section>

        <section
          className="brand-closing brand-container"
          aria-labelledby="closing-title"
        >
          <p className="brand-eyebrow">Your next question starts here</p>
          <h2 id="closing-title">Make room for discovery.</h2>
          <p>
            Bring your protocols and your curiosity. Keep the work in one place.
          </p>
          <Link
            to="/signup"
            search={{ next: "/protocols" }}
            className="brand-button"
          >
            Open your workspace <ArrowRight size={17} aria-hidden="true" />
          </Link>
        </section>
      </main>
      <footer className="brand-footer brand-container">
        <Link to="/" className="brand-logo" aria-label="Labee home">
          Labee<span className="brand-logo-period">.</span>
        </Link>
        <p>A workspace for protocol research.</p>
        <nav aria-label="Footer navigation">
          <a href="/privacy.html">Privacy</a>
          <a href="/support.html">Support</a>
          <Link to="/login" search={{ next: "/protocols" }}>
            Sign in
          </Link>
        </nav>
      </footer>
    </div>
  );
}
