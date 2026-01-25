# Plan: Quantum-Resistant Topic Unlinkability

## Obiettivo
Derivare i topic da `rootKey` (PQ-secure) invece che solo da `dhOutput` (classico X25519), ottenendo **quantum-resistant topic unlinkability** senza il costo di un PQ-ratchet completo.

## Analisi del Problema

**Stato attuale** (`kdf.ts:87-94`):
```typescript
export function deriveTopicFromDH(
  dhSharedSecret: Uint8Array,
  direction: 'outbound' | 'inbound',
  salt: Uint8Array  // conversationId
): `0x${string}` {
  const okm = hkdf(sha256, dhSharedSecret, salt, info, 32);
  return keccak256(okm);
}
```

**Problema**: IKM = `dhSharedSecret` (X25519 solo). Un avversario quantum passivo può:
1. Calcolare tutti i `dhSecret` futuri con Shor
2. Derivare tutti i topic e linkare i messaggi alla sessione originale

**Soluzione**: Usare `rootKey` (PQ-secure dall'handshake ibrido) come **salt** in HKDF:
```typescript
// Proposta
const okm = hkdf(sha256, dhOutput, rootKey, info, 32);
//                       ^IKM     ^salt (PQ-secure)
```

Questo sfrutta la proprietà di HKDF: anche conoscendo l'IKM, senza il salt l'output è indistinguibile da random.

## Proprietà di Sicurezza Preservate

| Proprietà | Prima | Dopo | Note |
|-----------|-------|------|------|
| **Bilateral Forward Secrecy** | ✓ | ✓ | DH ratchet continua a funzionare |
| **Post-Compromise Security (classical)** | ✓ | ✓ | Fresh DH → fresh chainKey |
| **PCS (quantum active)** | ✗ | ✗ | Richiede PQ-ratchet completo |
| **Topic-HS Unlinkability (classical)** | ✓ | ✓ | Invariato |
| **Topic-HS Unlinkability (quantum passive)** | ✗ | **✓** | **Nuovo** |
| **HNDL Resistance** | ✓ | ✓ | rootKey già PQ-secure |

## Refactor

### 1. Modificare `deriveTopicFromDH` → `deriveTopic`

**File**: `packages/sdk/src/ratchet/kdf.ts`

```typescript
/**
 * Derive topic from DH output using rootKey as PQ-secure salt.
 *
 * The rootKey (PQ-secure from hybrid handshake) acts as HKDF salt,
 * providing quantum-resistant topic unlinkability even if dhOutput
 * is later computed by a quantum adversary.
 */
export function deriveTopic(
  rootKey: Uint8Array,
  dhOutput: Uint8Array,
  direction: 'outbound' | 'inbound'
): `0x${string}` {
  const info = `verbeth:topic-${direction}:v3`;
  const okm = hkdf(sha256, dhOutput, rootKey, info, 32);
  return keccak256(okm) as `0x${string}`;
}

// REMOVE deriveTopicFromDH entirely (no migration needed)
```

**Note**:
- Rimosso `salt` (conversationId) - non necessario, rootKey fornisce domain separation
- `info` bumped a `:v3` per chiarezza
- rootKey come salt è crittograficamente corretto per HKDF
- **Nessuna deprecation**: rimuovere direttamente `deriveTopicFromDH`

### 2. Aggiornare `initSessionAsInitiator`

**File**: `packages/sdk/src/ratchet/session.ts` (linee 161-163)

```typescript
// Prima:
const epoch1TopicOut = deriveTopicFromDH(dhSend, 'outbound', saltBytes);
const epoch1TopicIn = deriveTopicFromDH(dhSend, 'inbound', saltBytes);

// Dopo:
const epoch1TopicOut = deriveTopic(finalRootKey, dhSend, 'outbound');
const epoch1TopicIn = deriveTopic(finalRootKey, dhSend, 'inbound');
```

`finalRootKey` è già disponibile nello scope (linea 153).

### 3. Aggiornare `dhRatchetStep`

**File**: `packages/sdk/src/ratchet/decrypt.ts` (linee 141-146)

```typescript
// Prima:
const newTopicOut = deriveTopicFromDH(dhReceive, 'inbound', saltBytes);
const newTopicIn = deriveTopicFromDH(dhReceive, 'outbound', saltBytes);
const nextTopicOut = deriveTopicFromDH(dhSend, 'outbound', saltBytes);
const nextTopicIn = deriveTopicFromDH(dhSend, 'inbound', saltBytes);

// Dopo:
const newTopicOut = deriveTopic(rootKey1, dhReceive, 'inbound');
const newTopicIn = deriveTopic(rootKey1, dhReceive, 'outbound');
const nextTopicOut = deriveTopic(rootKey2, dhSend, 'outbound');
const nextTopicIn = deriveTopic(rootKey2, dhSend, 'inbound');
```

`rootKey1` e `rootKey2` sono già derivati alle linee 126 e 136.

### 4. (Opzionale) Topic iniziali handshake

I topic dell'epoch 0 (handshake) sono derivati in `crypto.ts` durante l'handshake stesso. Questi usano ancora il DH dell'handshake ma con l'initial rootKey come salt.

**File**: `packages/sdk/src/crypto.ts` (se applicabile)

Se i topic handshake sono derivati con una funzione separata, aggiornare per usare il rootKey iniziale.

## File da Modificare

| File | Modifica |
|------|----------|
| `packages/sdk/src/ratchet/kdf.ts` | Nuova `deriveTopic()`, deprecare `deriveTopicFromDH` |
| `packages/sdk/src/ratchet/session.ts` | Aggiornare chiamate in `initSessionAsInitiator` |
| `packages/sdk/src/ratchet/decrypt.ts` | Aggiornare chiamate in `dhRatchetStep` |
| `packages/sdk/src/ratchet/index.ts` | Export nuova funzione |

## Epoch 0 (Handshake Topics) - Considerazioni Speciali

I topic dell'epoch 0 sono derivati in `VerbethClient.deriveTopicsFromDH()` **prima** che la sessione sia creata, quindi prima che il rootKey sia disponibile.

**Strategia**: Lasciare i topic epoch 0 con il vecchio schema (DH-only con conversationSalt).

**Razionale**:
1. L'handshake DH è già protetto dall'hybrid KEM → rootKey è PQ-secure
2. Dopo il primo DH ratchet (epoch 1+), i topic diventano PQ-unlinkable
3. Il "leak" è minimo: un avversario quantum può linkare l'epoch 0 all'handshake, ma non può:
   - Decifrare i messaggi (rootKey PQ-secure)
   - Linkare i topic epoch 1+ (derivati con rootKey come salt)
4. Propagare rootKey a VerbethClient richiederebbe refactor invasivo

**Alternativa (futura)**: Derivare topic epoch 0 da una forma intermedia del rootKey. Richiede refactor più profondo di `initSession*` e `deriveTopicsFromDH`.

## Non Modificare

- `VerbethClient.deriveTopicsFromDH()`: topic epoch 0 restano con vecchio schema
- `initSessionAsResponder`: non pre-computa next topics (Alice lo fa al primo ratchet)
- Handshake payload/protocol: nessun cambiamento wire format
- Storage format: i topic sono già stringhe, nessun cambiamento schema

## Backward Compatibility

**Non necessaria**: Verbeth non è ancora in produzione.

- Rimuovere `deriveTopicFromDH` direttamente
- Nessun migration path
- Aggiornare tutti i call site in un colpo solo

## Test da Aggiornare

**File**: `packages/sdk/test/ratchet.test.ts`

### Nuovi test per `deriveTopic`

```typescript
describe('deriveTopic (PQ-secure)', () => {
  it('derives deterministic topic from rootKey + dhOutput', () => {
    const rootKey = nacl.randomBytes(32);
    const dhOutput = nacl.randomBytes(32);

    const topic1 = deriveTopic(rootKey, dhOutput, 'outbound');
    const topic2 = deriveTopic(rootKey, dhOutput, 'outbound');

    expect(topic1).toBe(topic2);
  });

  it('derives different topics for different rootKeys (PQ-unlinkability)', () => {
    const rootKey1 = nacl.randomBytes(32);
    const rootKey2 = nacl.randomBytes(32);
    const dhOutput = nacl.randomBytes(32);  // STESSO dhOutput

    const topic1 = deriveTopic(rootKey1, dhOutput, 'outbound');
    const topic2 = deriveTopic(rootKey2, dhOutput, 'outbound');

    // Proprietà chiave: quantum adversary che conosce dhOutput
    // ma non rootKey non può derivare il topic
    expect(topic1).not.toBe(topic2);
  });

  it('derives different topics for different dhOutputs', () => {
    const rootKey = nacl.randomBytes(32);
    const dhOutput1 = nacl.randomBytes(32);
    const dhOutput2 = nacl.randomBytes(32);

    const topic1 = deriveTopic(rootKey, dhOutput1, 'outbound');
    const topic2 = deriveTopic(rootKey, dhOutput2, 'outbound');

    expect(topic1).not.toBe(topic2);
  });

  it('derives different topics for outbound vs inbound', () => {
    const rootKey = nacl.randomBytes(32);
    const dhOutput = nacl.randomBytes(32);

    const topicOut = deriveTopic(rootKey, dhOutput, 'outbound');
    const topicIn = deriveTopic(rootKey, dhOutput, 'inbound');

    expect(topicOut).not.toBe(topicIn);
  });
});
```

### Test da rimuovere

- `describe('deriveTopicFromDH', ...)` - sostituito dai nuovi test `deriveTopic`

### Test integrazione esistenti

I test `DH ratchet step - topic rotation` e `topic continuity` restano validi - verificano solo che i topic ruotino correttamente, non come sono derivati.

## Verifica End-to-End

1. **Unit test**: `npm test` nella SDK
2. **Integration test**:
   - Creare sessione con hybrid handshake
   - Inviare messaggi, verificare topic rotation
   - Controllare che `session.rootKey` sia usato nella derivazione
3. **Security test manuale**:
   - Log `deriveTopic` inputs/outputs
   - Verificare che stesso dhOutput + rootKey diversi → topic diversi
