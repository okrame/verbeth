import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'overview',
    'quick-start',
    {
      type: 'category',
      label: 'Concepts',
      collapsed: false,
      collapsible: true,
      items: [
        'concepts/identity',
        'concepts/handshake',
        {
          type: 'category',
          label: 'Ratchet',
          collapsed: false,
          collapsible: true,
          items: [
            'concepts/ratchet/double-ratchet',
            'concepts/ratchet/topic-ratcheting',
          ],
        },
        {
          type: 'category',
          label: 'Security',
          collapsed: false,
          collapsible: true,
          items: [
            'concepts/security/threat-model',
            'concepts/security/cryptographic-guarantees',
            'concepts/security/metadata-privacy',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'How It Works',
      collapsed: false,
      collapsible: true,
      items: [
        'how-it-works/wire-format',
        'how-it-works/protocol-flow',
        'how-it-works/ratchet-internals',
      ],
    },
    {
      type: 'category',
      label: 'Roadmap',
      collapsed: false,
      collapsible: true,
      items: [
        'roadmap/metadata-privacy-psi',
      ],
    },
  ],
};

export default sidebars;
