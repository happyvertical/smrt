import Heading from '@theme/Heading';
import clsx from 'clsx';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  icon: string;
  description: JSX.Element;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Define Once, Generate Everything',
    icon: '✨',
    description: (
      <>
        Use the @smrt() decorator to define your business logic once.
        Automatically generate REST APIs, AI tools (MCP), and CLI commands
        from a single source of truth.
      </>
    ),
  },
  {
    title: 'AI-Powered Operations',
    icon: '🤖',
    description: (
      <>
        Built-in AI methods like do(), is(), and describe() enable intelligent
        operations on your objects. Let AI handle complex logic while you focus
        on building features.
      </>
    ),
  },
  {
    title: 'Database Persistence',
    icon: '💾',
    description: (
      <>
        Automatic schema generation and migrations with SmrtObject. Type-safe
        database operations for SQLite, Postgres, and DuckDB with zero
        configuration.
      </>
    ),
  },
];

function Feature({ title, icon, description }: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <div
          className={styles.featureSvg}
          role="img"
          style={{ fontSize: '4rem' }}
        >
          {icon}
        </div>
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): JSX.Element {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
