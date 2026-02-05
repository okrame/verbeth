# Verbeth SDK Documentation Plan

### Obiettivo
Creare una documentazione minimale ma funzionale con un quick start efficace che permetta a qualsiasi sviluppatore web3 di integrare Verbeth SDK in pochi minuti.

---

## Struttura Documentazione (Progressive Disclosure)

```
docs/
├── quick-start.md          ← Milestone 1
├── concepts/               ← Milestone 2
│   ├── how-it-works.md
│   ├── identity.md
│   ├── handshake.md
│   ├── ratchet.md
│   └── security.md
├── guides/                 ← Milestone 3
│   ├── react-integration.md
│   ├── storage-adapters.md
│   ├── smart-accounts.md
│   └── event-listening.md
└── reference/              ← Milestone 4
    ├── api/
    ├── types/
    └── constants.md
```

---

## Note per Milestones Future

**Milestone 3 (Guides)**:
- React hooks pattern
- Custom storage adapters
- Safe modules integration
- Smart account integration (base smart account executor was predefined but erc4337 infrastrucutre it is a too expensive option for now, for simple messaging)
- Event listening strategies

**Milestone 4 (Reference)**:
- Auto-generated API docs
- Type definitions
- Contract ABIs
