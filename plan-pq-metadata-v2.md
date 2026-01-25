# Plan v2: PQ-Secure Metadata Unlinkability (Meno Invasivo)

## Obiettivo
Stesso del piano v1: eliminare metadata leak per avversari quantum passivi. Non ci interessa migrazione. 

**Vincolo aggiuntivo**: NON modificare il contratto LogChainV1.sol. R (responderEphemeralR) deve rimanere utile.
Non essere ridondante con i commenti nel nuovo codice. 

## Le Due Vulnerabilita

### 1. Topic Epoch 0 (VerbethClient.ts:338-342)
```typescript
// Attuale: solo X25519 DH + salt
const ephemeralShared = dh(mySecret, theirPublic);
const okm = hkdf(sha256, ephemeralShared, salt, info, 32);
```
**Problema**: Un quantum attacker puo derivare `ephemeralShared` dalle chiavi pubbliche on-chain.

### 2. inResponseTo (crypto.ts:162-168)
```typescript
// Attuale: solo ECDH
const shared = nacl.scalarMult(rSecretKey, viewPubA);
return finalizeHsrTag(shared);
```
**Problema**: Con R e viewPubA entrambi on-chain, un quantum attacker puo calcolare `shared` e linkare HS→HSR.

---

## Soluzione: Tag Ibrido (Mantiene R Utile)

### Idea Chiave
Invece di rimuovere R dal calcolo del tag, combiniamo **sia kemSecret che ECDH**:

```
tag = H(KDF(kemSecret, ECDH(r, viewPubA), "verbeth:hsr-hybrid"))
```

**Proprieta**:
- R e ancora necessario (per calcolare ECDH)
- kemSecret e necessario (PQ-secure component)
- Un quantum attacker puo rompere ECDH ma NON puo forgiare kemSecret
- Il contratto NON cambia

---

## Refactor 1: Topic Epoch 0 PQ-Secure

**File**: `packages/sdk/src/client/VerbethClient.ts`

### Cambiamento
Aggiungere `kemSecret` come parametro e usarlo nel derivation:

```typescript
private deriveTopicsFromDH(
  mySecret: Uint8Array,
  theirPublic: Uint8Array,
  salt: Uint8Array,
  isInitiator: boolean,
  kemSecret?: Uint8Array  // NUOVO parametro opzionale
): { topicOutbound: `0x${string}`; topicInbound: `0x${string}` } {
  const ephemeralShared = dh(mySecret, theirPublic);

  // Se kemSecret presente, usa derivazione ibrida
  const inputKeyMaterial = kemSecret
    ? hybridInitialSecret(ephemeralShared, kemSecret)
    : ephemeralShared;

  const deriveEpoch0Topic = (direction: 'outbound' | 'inbound'): `0x${string}` => {
    const info = `verbeth:topic-${direction}:v2`;
    const okm = hkdf(sha256, inputKeyMaterial, salt, info, 32);
    return keccak256(okm) as `0x${string}`;
  };
  // ... rest unchanged
}
```

### Call Sites da Aggiornare

1. **acceptHandshake()** (linea ~185): passare `kemSharedSecret`
2. **createInitiatorSession()** (linea ~237): passare `kemSecret` (da decapsulation)

### Impatto
- Minimo: solo aggiunta parametro opzionale
- Backward compat: senza kemSecret comportamento invariato

---

## Refactor 2: Tag HSR Ibrido (R Rimane Utile)

**File**: `packages/sdk/src/crypto.ts`

### Nuove Funzioni

```typescript
/**
 * Hybrid HSR tag: combines KEM secret (PQ) and ECDH (classical).
 * Both are required - quantum attacker cannot compute without kemSecret.
 *
 * R is still necessary to compute ecdhShared.
 */
export function computeHybridHsrTag(
  kemSecret: Uint8Array,
  ecdhShared: Uint8Array
): `0x${string}` {
  // kemSecret as IKM, ecdhShared as salt -> both required
  const okm = hkdf(sha256, kemSecret, ecdhShared, toUtf8Bytes("verbeth:hsr-hybrid:v1"), 32);
  return keccak256(okm) as `0x${string}`;
}

/**
 * Responder computes hybrid tag.
 * Uses R's secret key for ECDH + kemSecret from encapsulation.
 */
export function computeHybridTagFromResponder(
  rSecretKey: Uint8Array,
  viewPubA: Uint8Array,
  kemSecret: Uint8Array
): `0x${string}` {
  const ecdhShared = nacl.scalarMult(rSecretKey, viewPubA);
  return computeHybridHsrTag(kemSecret, ecdhShared);
}

/**
 * Initiator computes hybrid tag for verification.
 * Uses viewPrivA for ECDH + kemSecret from decapsulation.
 */
export function computeHybridTagFromInitiator(
  viewPrivA: Uint8Array,
  R: Uint8Array,
  kemSecret: Uint8Array
): `0x${string}` {
  const ecdhShared = nacl.scalarMult(viewPrivA, R);
  return computeHybridHsrTag(kemSecret, ecdhShared);
}
```

### Perche R Rimane Utile
- `computeHybridTagFromInitiator(viewPrivA, R, kemSecret)` richiede R
- Senza R, l'initiator non puo calcolare `ecdhShared`
- Il tag dipende da entrambi: KEM (PQ) + ECDH (classical binding a R)

---

## Refactor 3: send.ts (respondToHandshake)

**File**: `packages/sdk/src/send.ts`

### Cambiamento (linee 173-176)

```typescript
// PRIMA:
const inResponseTo = computeTagFromResponder(tagKeyPair.secretKey, initiatorX25519Pub);

// DOPO:
const inResponseTo = computeHybridTagFromResponder(
  tagKeyPair.secretKey,
  initiatorX25519Pub,
  kemSharedSecret  // gia disponibile da encapsulation (linea 187)
);
```

**Nota**: Bisogna riordinare il codice per fare KEM encapsulation PRIMA del tag computation.

### Riordino Necessario

```typescript
// 1. Handle KEM FIRST (spostare prima del tag)
let kemSharedSecret: Uint8Array | undefined;
let kemCiphertext: Uint8Array | undefined;
if (initiatorEphemeralPubKey.length === 32 + 1184) {
  const initiatorKemPub = initiatorEphemeralPubKey.slice(32);
  const result = kem.encapsulate(initiatorKemPub);
  kemCiphertext = result.ciphertext;
  kemSharedSecret = result.sharedSecret;
}

// 2. Compute tag (now has kemSharedSecret)
const inResponseTo = kemSharedSecret
  ? computeHybridTagFromResponder(tagKeyPair.secretKey, initiatorX25519Pub, kemSharedSecret)
  : computeTagFromResponder(tagKeyPair.secretKey, initiatorX25519Pub);  // fallback classico
```

---

## Refactor 4: HsrTagIndex (Matching Ibrido)

**File**: `packages/sdk/src/client/HsrTagIndex.ts`

### Cambiamento Dati

```typescript
interface PendingContactEntry {
  address: string;
  handshakeEphemeralSecret: Uint8Array;  // viewPrivA - MANTIENI
  kemSecretKey?: Uint8Array;              // NUOVO: per decapsulation
}
```

### Matching Logic Ibrida

```typescript
/**
 * Match HSR to pending contact.
 *
 * @param inResponseToTag - Tag from HSR event
 * @param R - responderEphemeralR from event (still needed!)
 * @param kemCiphertext - KEM ciphertext from decrypted payload (optional)
 */
matchByTag(
  inResponseToTag: `0x${string}`,
  R: Uint8Array,
  kemCiphertext?: Uint8Array
): string | null {
  // Fast path: cache lookup
  const cached = this.tagToAddress.get(inResponseToTag);
  if (cached) return cached;

  // Slow path: try each contact
  for (const [address, entry] of this.entries) {
    let expectedTag: `0x${string}`;

    if (kemCiphertext && entry.kemSecretKey) {
      // Hybrid matching (PQ-secure)
      const kemSecret = kem.decapsulate(kemCiphertext, entry.kemSecretKey);
      expectedTag = computeHybridTagFromInitiator(
        entry.handshakeEphemeralSecret,
        R,  // R e ancora usato!
        kemSecret
      );
    } else {
      // Classic matching (backward compat)
      expectedTag = computeTagFromInitiator(entry.handshakeEphemeralSecret, R);
    }

    // Cache for future lookups
    this.tagToAddress.set(expectedTag, address);

    if (expectedTag === inResponseToTag) {
      return address;
    }
  }
  return null;
}
```

### R e Ancora Usato!
Nel nuovo matching, R serve per:
1. Calcolare `ecdhShared = ECDH(viewPrivA, R)`
2. Combinare con kemSecret per il tag ibrido

---

## Refactor 5: verify.ts (Verifica HSR)

**File**: `packages/sdk/src/verify.ts` (linee 263-270)

### Cambiamento

```typescript
// PRIMA:
const expectedTag = computeTagFromInitiator(initiatorEphemeralSecretKey, Rbytes);

// DOPO:
const expectedTag = kemSecret
  ? computeHybridTagFromInitiator(initiatorEphemeralSecretKey, Rbytes, kemSecret)
  : computeTagFromInitiator(initiatorEphemeralSecretKey, Rbytes);
```

---

## Riepilogo Modifiche

| File | Modifica | Invasivita |
|------|----------|------------|
| `crypto.ts` | Aggiungi funzioni ibride (mantieni le vecchie) | Bassa |
| `send.ts` | Riordina KEM prima del tag, usa hybrid | Media |
| `VerbethClient.ts` | Aggiungi param `kemSecret` a deriveTopicsFromDH | Bassa |
| `HsrTagIndex.ts` | Aggiungi `kemSecretKey`, matching ibrido | Media |
| `verify.ts` | Supporto verifica ibrida | Bassa |
| **LogChainV1.sol** | **NESSUNA MODIFICA** | - |

---

## Cosa NON Cambia

1. **Contratto**: LogChainV1.sol rimane identico
2. **Evento HSR**: `responderEphemeralR` rimane nel contratto e viene usato
3. **Funzioni esistenti**: `computeTagFromResponder/Initiator` restano (backward compat)
4. **R on-chain**: Necessario per ECDH nel tag ibrido

---

## Proprieta di Sicurezza

| Proprieta | Prima | Dopo |
|-----------|-------|------|
| Topic Epoch 0 (quantum) | X (solo ECDH) | V (ibrido) |
| HS→HSR Unlinkability (quantum) | X (R linkabile) | V (kemSecret required) |
| R utilita | V (tag ECDH) | V (tag ibrido) |
| Backward compat | - | V (fallback classico) |

---

## Test

```typescript
describe('PQ-secure hybrid tag', () => {
  it('requires both kemSecret and R to compute tag', () => {
    const viewPrivA = randomBytes(32);
    const viewPubA = getPublicKey(viewPrivA);
    const { secretKey: r, publicKey: R } = nacl.box.keyPair();
    const kemSecret = randomBytes(32);

    // Responder computes
    const tagResp = computeHybridTagFromResponder(r, viewPubA, kemSecret);

    // Initiator verifies (needs R!)
    const tagInit = computeHybridTagFromInitiator(viewPrivA, R, kemSecret);

    expect(tagResp).toBe(tagInit);
  });

  it('different kemSecret = different tag (PQ unlinkability)', () => {
    const viewPrivA = randomBytes(32);
    const viewPubA = getPublicKey(viewPrivA);
    const { secretKey: r } = nacl.box.keyPair();

    const tag1 = computeHybridTagFromResponder(r, viewPubA, randomBytes(32));
    const tag2 = computeHybridTagFromResponder(r, viewPubA, randomBytes(32));

    // Same ECDH, different KEM -> different tags
    expect(tag1).not.toBe(tag2);
  });

  it('quantum attacker cannot compute tag without kemSecret', () => {
    // Attacker has: viewPubA (from HS), R (from HSR), can compute ECDH
    // Attacker missing: kemSecret (encrypted in HSR payload)
    // Result: cannot compute hybrid tag -> no linkability
  });
});
```

---

## Demo App (apps/demo)

Le modifiche alla demo app saranno minime perche il core logic e nell'SDK.

**useMessageListener.ts**:
- Estrarre `kemCiphertext` dal payload HSR decryptato
- Passarlo a `matchByTag(tag, R, kemCiphertext)`

**useChatActions.ts**:
- Salvare `kemSecretKey` quando si manda un HS (gia fatto per `handshakeKemSecret`)

---

## Ordine di Implementazione

1. `crypto.ts` - Aggiungere funzioni ibride
2. `send.ts` - Usare tag ibrido
3. `VerbethClient.ts` - Propagare kemSecret a deriveTopicsFromDH
4. `HsrTagIndex.ts` - Matching ibrido
5. `verify.ts` - Verifica ibrida
6. Test
7. Demo app adjustments
