import { Alert, Badge, Card, Icon } from "../ui";
import { LinkButton } from "../ui/LinkButton";
import { routes, site } from "../site";
import { exampleDocument, features, principles, questions, steps } from "./content";
import styles from "./landing.module.css";

/**
 * The page a visitor sees at `/` (DESIGN.md §3, journey 1): what Fjord is, why, what it
 * does, and a way in. A Server Component: it renders to static HTML, the FAQ is native
 * `<details>`, and the only script on the page is the theme one in the layout.
 *
 * A signed-in user will see their repository here instead (ROADMAP 1a.9), once there is a
 * session to tell them apart by (1a.2).
 */
export function Landing() {
  return (
    <>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>

      <header className={styles.header}>
        <div className={`${styles.container} ${styles.headerInner}`}>
          <a className={styles.brand} href="/" aria-label={`${site.name}, home`}>
            {site.name}
          </a>
          <nav className={styles.nav} aria-label="Sections">
            <a href="#why">Why</a>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className={styles.actions}>
            <LinkButton href={routes.signIn} variant="secondary">
              Sign in
            </LinkButton>
            <LinkButton href={routes.signUp}>Sign up</LinkButton>
          </div>
        </div>
      </header>

      <main id="main">
        <div className={styles.container}>
          <div className={styles.notice}>
            <Alert variant="info" heading="Fjord Web is being built in the open">
              Signing in and the editor are not available yet. This page says what Fjord is for and how it will work.
            </Alert>
          </div>
        </div>

        <section className={`${styles.container} ${styles.hero}`} aria-labelledby="hero-title">
          <div className={styles.heroText}>
            <h1 id="hero-title" className={styles.title}>
              Documents and notes <span className={styles.titleEnd}>you actually own.</span>
            </h1>
            <p className={styles.lead}>
              Write, share and comment on documents in your browser. Every file is plain Markdown in a Git repository you control,
              readable without Fjord, with optional end-to-end encryption.
            </p>
            <div className={styles.cta}>
              <LinkButton href={routes.signUp} size="lg">
                Get started
              </LinkButton>
              <LinkButton href="#how" variant="secondary" size="lg">
                How it works
              </LinkButton>
            </div>
          </div>

          <figure className={styles.example}>
            <figcaption className={styles.exampleCaption}>
              <Icon name="file-text" size="sm" aria-hidden />
              <span>{exampleDocument.path}</span>
            </figcaption>
            <pre className={styles.code}>
              <code>{exampleDocument.source}</code>
            </pre>
            <p className={styles.exampleNote}>That is the whole file: Markdown with a small header. Nothing else to export.</p>
          </figure>
        </section>

        <section id="why" className={styles.section} aria-labelledby="why-title">
          <div className={styles.container}>
            <h2 id="why-title" className={styles.sectionTitle}>
              Why Fjord
            </h2>
            <p className={styles.sectionLead}>
              Your documents should outlive any tool, including this one. So Fjord is built around three promises.
            </p>
            <ul className={styles.grid3}>
              {principles.map((principle) => (
                <li key={principle.id}>
                  <Card as="article" padding="lg" className={styles.card}>
                    <Icon name={principle.icon} size="lg" aria-hidden />
                    <h3 className={styles.cardTitle}>{principle.title}</h3>
                    <p className={styles.cardBody}>{principle.body}</p>
                    {principle.later ? (
                      <Badge variant="status" status="pending">
                        Comes after the first release
                      </Badge>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="features" className={`${styles.section} ${styles.sunken}`} aria-labelledby="features-title">
          <div className={styles.container}>
            <h2 id="features-title" className={styles.sectionTitle}>
              What you can do
            </h2>
            <ul className={styles.grid}>
              {features.map((feature) => (
                <li key={feature.id} className={styles.feature}>
                  <span className={styles.featureIcon}>
                    <Icon name={feature.icon} size="md" aria-hidden />
                  </span>
                  <h3 className={styles.featureTitle}>{feature.title}</h3>
                  <p className={styles.cardBody}>{feature.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="how" className={styles.section} aria-labelledby="how-title">
          <div className={styles.container}>
            <h2 id="how-title" className={styles.sectionTitle}>
              How it works
            </h2>
            <ol className={styles.steps}>
              {steps.map((step, index) => (
                <li key={step.id} className={styles.step}>
                  <span className={styles.stepNumber} aria-hidden="true">
                    {index + 1}
                  </span>
                  <h3 className={styles.featureTitle}>{step.title}</h3>
                  <p className={styles.cardBody}>{step.body}</p>
                </li>
              ))}
            </ol>
            <div className={styles.cta}>
              <LinkButton href={routes.signUp} size="lg">
                Create an account
              </LinkButton>
              <LinkButton href={routes.signIn} variant="secondary" size="lg">
                Sign in
              </LinkButton>
            </div>
          </div>
        </section>

        <section id="faq" className={`${styles.section} ${styles.sunken}`} aria-labelledby="faq-title">
          <div className={`${styles.container} ${styles.narrow}`}>
            <h2 id="faq-title" className={styles.sectionTitle}>
              Questions
            </h2>
            <div className={styles.faq}>
              {questions.map((item) => (
                <details key={item.id} className={styles.question}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerInner}`}>
          <p>
            <strong>{site.name}</strong> is open source, under the {site.licence} licence.
          </p>
          <nav aria-label="Project">
            <a href={site.repository}>Source code</a>
            <a href={site.specification}>Format specification</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
