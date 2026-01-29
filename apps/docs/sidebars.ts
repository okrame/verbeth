import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'quick-start',
    {
      type: 'category',
      label: 'Concepts',
      items: [
        'concepts/how-it-works',
        'concepts/identity',
        'concepts/handshake',
        'concepts/ratchet',
        'concepts/security',
      ],
    },
  ],
};

export default sidebars;
