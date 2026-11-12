# ADR-002 - Cifratura zero-knowledge dei dati delle analisi e dei profili disattivati

- **Stato:** Accepted
- **Data:** 2026-11-12
- **Contesto:** branch `dev` di Instagram Follower Tracker (web app statica su Firebase Hosting)
- **Owner:** CTO
- **Sostituisce parzialmente:** ADR-001 (modello dati su Firestore)

## Contesto

ADR-001 ha reso Firestore la fonte di verità per gli utenti autenticati: profilo, storico
delle analisi e profili disattivati. I dati erano però salvati in chiaro, quindi chi amministra
il progetto Firebase (o il database) poteva leggerli.

Il requisito espresso dal titolare è **zero-knowledge**: il database non deve contenere
username delle analisi né dei profili disattivati in forma leggibile. Deve restare visibile
solo il profilo dell'utente (email, nome, impostazioni).

## Decisione

Cifratura **end-to-end lato client** con envelope encryption (Web Crypto API, nessuna libreria
esterna).

### Chiavi

| Elemento | Descrizione |
| --- | --- |
| **DEK** | chiave AES-GCM 256 casuale, unica per utente |
| **KEK** | derivata dalla *frase di sicurezza* scelta dall'utente con PBKDF2-SHA256, 310.000 iterazioni, salt casuale 16 byte |
| **Record `keyVault`** | `{v, kdf, iterations, salt, iv, wrappedKey}` salvato in `users/{uid}`: contiene solo la DEK *avvolta* con la KEK |
| **Chiave dedupe** | derivata dalla DEK con HKDF-SHA256, usata per HMAC degli username |

La frase di sicurezza non lascia mai il browser e non viene salvata. Non coincide con la
password di accesso, perché l'accesso con Google non fornisce una password utilizzabile come
segreto.

### Dati cifrati

- `users/{uid}/analyses/{id}` → `{ createdAt, enc }`, dove `enc` è il payload JSON cifrato
  (conteggi, `chunkCount`, flag `truncated`).
- `users/{uid}/analyses/{id}/items/chunk-NNN` → `{ enc }`, dove `enc` è l'array di username
  cifrato.
- `users/{uid}/deactivated/{docId}` → `{ enc }` con `{username, markedAt}` cifrati.
  `docId = hex(HMAC-SHA256(dedupeKey, username))`: opaco e deterministico, così il client
  deduplica senza che il server veda la username.

Ogni valore usa un **IV casuale di 12 byte**; AES-GCM garantisce integrità e autenticità.

### Metadati residui (accettati e documentati)

Restano leggibili: email/nome del profilo, record `keyVault` (inutile senza frase), timestamp
`createdAt` dell'analisi, ID dei documenti e numero di documenti. Sono necessari per ordinare
lo storico e applicare i limiti; non contengono username.

### Gestione della chiave durante la sessione

- La DEK è tenuta in memoria.
- Per comodità viene salvata in IndexedDB come `CryptoKey` **non estraibile**, con la chiave
  dedupe, per utente. Al ritorno sullo stesso browser non serve reinserire la frase; nessuno
  script può esportarne il valore grezzo.
- "Blocca i dati" e "Elimina account e dati" rimuovono la cache dal dispositivo.
- Se IndexedDB non è disponibile, la chiave resta solo in memoria e la frase viene richiesta
  a ogni caricamento.

### Comportamento in assenza di chiave

Se l'utente autenticato non ha ancora attivato la cifratura o l'ha bloccata:

- **nessun dato sensibile viene letto o scritto su Firestore** (mai fallback in chiaro);
- analisi e disattivati restano nella cache locale e vengono accodati;
- al primo sblocco/attivazione i dati locali e la coda vengono cifrati e sincronizzati.

### Migrazione dei dati in chiaro

Al primo sync con chiave disponibile, i documenti creati dalla versione precedente (analisi
con campi piatti, chunk con `usernames`, disattivati con ID = username) vengono ri-cifrati e
la copia in chiaro viene eliminata. La migrazione dei disattivati è a ogni sync (idempotente);
quella delle analisi è una tantum per dispositivo (`igft.cryptoMigrated.{uid}`).

## Alternative valutate

| Alternativa | Perché scartata |
| --- | --- |
| Cifratura server-side con chiave gestita da KMS | Il gestore/DB potrebbe comunque decifrare: non soddisfa zero-knowledge. |
| Derivare la KEK dalla password di Firebase | Non funziona con Google Sign-In e la password non è disponibile nelle sessioni silenziose. |
| Chiave in chiaro in Firestore | Nessuna protezione reale: chi amministra il DB la leggerebbe. |
| Chiave solo in memoria, nessuna cache | Massima sicurezza ma UX insostenibile: frase a ogni caricamento. |
| Chiave derivata da un segreto condiviso con il server | Il server tornerebbe a poter decifrare. |

## Conseguenze

Positive:

- Il database non contiene username in chiaro: requisito zero-knowledge soddisfatto.
- Le regole Firestore non devono (e non possono) verificare il contenuto cifrato: resta il
  controllo owner-only.
- Nessuna dipendenza aggiuntiva: solo Web Crypto del browser.

Negative / rischi:

- **Perdita della frase = perdita dei dati**: mitigato con avvisi espliciti, generatore di
  frase robusta e possibilità di cambiarla senza perdere i dati.
- **Metadati residui** (timestamp, numero di documenti): accettati e documentati.
- **Copia locale in chiaro** nel browser: è il dispositivo dell'utente, non il database;
  viene rimossa con "Blocca i dati" e "Elimina account e dati".
- **Prestazioni**: PBKDF2 a 310.000 iterazioni al primo sblocco (ordine di grandezza: qualche
  centinaio di ms su desktop, ~1 s su dispositivi lenti).
- **Dati già in chiaro** finché la migrazione non viene eseguita: richiede un accesso con
  chiave sbloccata.

## Follow-up

- Valutare un "kit di recupero" esportabile (frase + istruzioni) al momento dell'attivazione.
- Valutare la rotazione periodica della DEK con re-cifratura in background.
- Aggiungere test end-to-end con Firebase Emulator Suite per la migrazione.
