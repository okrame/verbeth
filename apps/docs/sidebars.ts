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
        'concepts/security',
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
  ],
};

export default sidebars;
