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
        'concepts/ratchet',
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
      ],
    },
  ],
};

export default sidebars;
