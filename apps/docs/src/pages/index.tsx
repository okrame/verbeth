import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';

export default function Home(): ReactNode {
  return (
    <Layout
      title="End-to-end encrypted messaging over Ethereum"
      description="Verbeth SDK - End-to-end encrypted messaging protocol using Ethereum as the transport layer">
      <main className="hero-verbeth">
        <h1>Verbeth SDK</h1>
        <p>End-to-end encrypted messaging over Ethereum</p>
        <div className="hero-buttons">
          <Link to="/docs/quick-start">Get Started</Link>
          <Link href="https://github.com/okrame/verbeth-sdk">GitHub</Link>
        </div>
      </main>
    </Layout>
  );
}
