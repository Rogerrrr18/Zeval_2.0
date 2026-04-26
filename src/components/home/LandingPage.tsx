"use client";

import Link from "next/link";
import { useState } from "react";
import { LANDING_COPY, type Locale } from "@/i18n/landing";
import styles from "./landingPage.module.css";

const LOCALE_STORAGE_KEY = "zerore:locale";

/**
 * Read the persisted landing page locale, falling back to Chinese for first-time visitors.
 *
 * @returns The initial locale used by the client component.
 */
function getInitialLocale(): Locale {
  if (typeof window === "undefined") {
    return "zh";
  }

  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return stored === "zh" || stored === "en" ? stored : "zh";
}

/**
 * Render the public-facing bilingual landing page (zh default, en switchable).
 */
export function LandingPage() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);

  /**
   * Toggle locale and persist it to localStorage.
   */
  function handleToggleLocale() {
    setLocale((current) => {
      const next: Locale = current === "zh" ? "en" : "zh";
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      if (typeof document !== "undefined") {
        document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
      }
      return next;
    });
  }

  const copy = LANDING_COPY[locale];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="ZERORE home">
          <span className={styles.brandMark}>ZE</span>
          <span className={styles.brandWord}>ZERORE</span>
        </Link>
        <nav className={styles.nav} aria-label="primary">
          {copy.nav.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.langToggle}
            onClick={handleToggleLocale}
            aria-label={`Switch to ${copy.langSwitch.switchTo}`}
          >
            <span className={styles.langActive}>{copy.langSwitch.label}</span>
            <span className={styles.langDivider} aria-hidden>/</span>
            <span className={styles.langInactive}>{copy.langSwitch.switchTo}</span>
          </button>
          <Link href="/contact" className={styles.primaryPill}>
            {copy.ctaPrimary}
          </Link>
          <Link href="/workbench" className={styles.loginPill}>
            <span>{copy.ctaLogin}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M15 3h6v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M10 14L21 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path
                d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>{copy.hero.eyebrow}</p>
          <h1 className={styles.heroHeadline}>
            {copy.hero.headline.line1}
            <br />
            {copy.hero.headline.line2Pre}
            <span className={styles.heroAccent}>{copy.hero.headline.accent}</span>
            {copy.hero.headline.line2Post}
          </h1>
          <p className={styles.heroLead}>
            {copy.hero.lead.intro}
            <strong>{copy.hero.lead.bold}</strong>
            {copy.hero.lead.outro}
          </p>
          <div className={styles.heroActions}>
            <Link href="/contact" className={styles.primaryPill}>
              {copy.ctaPrimary}
            </Link>
            <Link href="/workbench" className={styles.secondaryPill}>
              {copy.ctaSecondary}
            </Link>
          </div>
          <dl className={styles.heroStats}>
            {copy.hero.stats.map((stat) => (
              <div key={stat.label}>
                <dt>{stat.label}</dt>
                <dd>{stat.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className={styles.trustStrip} aria-label={copy.trustHeader}>
          <p>{copy.trustHeader}</p>
          <ul>
            {copy.trustLogos.map((logo) => (
              <li key={logo}>{logo}</li>
            ))}
          </ul>
        </section>

        <section className={styles.section} id="capabilities">
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrowMuted}>{copy.capabilitiesSection.eyebrow}</p>
            <h2>{copy.capabilitiesSection.title}</h2>
            <p className={styles.sectionLead}>{copy.capabilitiesSection.lead}</p>
          </div>
          <div className={styles.capabilityGrid}>
            {copy.capabilities.map((item) => (
              <article className={styles.capabilityCard} key={item.title}>
                <span className={styles.capabilityEyebrow}>{item.eyebrow}</span>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
                <ul>
                  {item.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.loopSection} id="loop">
          <div className={styles.sectionIntroInverse}>
            <p className={styles.eyebrowLight}>{copy.loopSection.eyebrow}</p>
            <h2>{copy.loopSection.title}</h2>
          </div>
          <div className={styles.loopGrid}>
            {copy.loopSteps.map((item, index) => (
              <article className={styles.loopCard} key={item.step}>
                <span>Step {index + 1}</span>
                <strong>{item.step}</strong>
                <p>{item.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} id="outcomes">
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrowMuted}>{copy.outcomesSection.eyebrow}</p>
            <h2>{copy.outcomesSection.title}</h2>
          </div>
          <div className={styles.outcomeGrid}>
            {copy.outcomes.map((item) => (
              <article className={styles.outcomeCard} key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.testimonialSection} id="testimonials">
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrowMuted}>{copy.testimonialsSection.eyebrow}</p>
            <h2>{copy.testimonialsSection.title}</h2>
          </div>
          <div className={styles.testimonialGrid}>
            {copy.testimonials.map((item) => (
              <figure className={styles.testimonialCard} key={item.author}>
                <blockquote>“{item.quote}”</blockquote>
                <figcaption>— {item.author}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className={styles.faqSection} id="faq">
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrowMuted}>{copy.faqSection.eyebrow}</p>
            <h2>{copy.faqSection.title}</h2>
          </div>
          <div className={styles.faqList}>
            {copy.faq.map((item) => (
              <details className={styles.faqItem} key={item.question}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.ctaSection}>
          <div>
            <p className={styles.eyebrowMuted}>{copy.cta.eyebrow}</p>
            <h2>{copy.cta.title}</h2>
            <p className={styles.sectionLead}>{copy.cta.lead}</p>
          </div>
          <div className={styles.ctaActions}>
            <Link href="/contact" className={styles.primaryPill}>
              {copy.ctaPrimary}
            </Link>
            <Link href="/workbench" className={styles.secondaryPill}>
              {copy.ctaSecondary}
            </Link>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <span className={styles.brandMark}>ZE</span>
            <div>
              <strong>ZERORE</strong>
              <p>{copy.footer.tagline}</p>
            </div>
          </div>
          <div className={styles.footerLinks}>
            <div>
              <h4>{copy.footer.columns.product.title}</h4>
              {copy.footer.columns.product.links.map((link) => (
                <Link key={link.href} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </div>
            <div>
              <h4>{copy.footer.columns.resources.title}</h4>
              {copy.footer.columns.resources.links.map((link) => (
                <Link key={link.href} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </div>
            <div>
              <h4>{copy.footer.columns.company.title}</h4>
              {copy.footer.columns.company.links.map((link) => (
                <Link key={link.href} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
        <div className={styles.footerBottom}>
          <span>{copy.footer.copyright(new Date().getFullYear())}</span>
          <span>{copy.footer.builtFor}</span>
        </div>
      </footer>
    </div>
  );
}
