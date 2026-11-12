# Setup Firebase — account facoltativo, storico e profili disattivati

Questa guida copre la configurazione Firebase necessaria alla versione `dev` dell'app.
La web app resta statica: **nessun backend custom**, solo Firebase Authentication + Cloud Firestore.

## Architettura in breve

| Componente | Uso |
| --- | --- |
| Firebase Hosting | Serving dei file statici in `public/` |
| Firebase Authentication | Registrazione/login email-password e Google (facoltativi) |
| Cloud Firestore | Fonte di verità per profilo (email/nome), impostazioni e record della chiave cifrata. Analisi e profili disattivati sono **cifrati end-to-end** nel browser |
| localStorage | Modalità ospite e cache locale per l'uso offline; le modifiche in coda vengono inviate a Firestore |

La configurazione web viene letta a runtime da `/__/firebase/init.json`, endpoint riservato
di Firebase Hosting: **nessuna chiave o configurazione hardcodata nel repository**.
Se l'endpoint non è disponibile (file locale, server statico generico) l'app resta in
modalità ospite e la pagina `login.html` mostra l'avviso con il link per continuare come ospite.

## Prerequisiti

- Progetto Firebase `igfollowertracking-v2` (già referenziato in `.firebaserc`).
- Firebase CLI installata e autenticata (`firebase login`).
- Piano Spark sufficiente per uso personale; valutare Blaze se si usano preview channel o volumi elevati.

## 1. Abilitare i metodi di accesso

Console Firebase → **Authentication** → **Sign-in method**:

1. **Email/Password**: abilitare.
2. **Google** (opzionale ma consigliato): abilitare e impostare l'email di supporto del progetto.

Senza questi passaggi il login restituisce `auth/operation-not-allowed`.

## 2. Creare Firestore e pubblicare le regole

Stato del progetto `igfollowertracking-v2`: database **`(default)`** creato in modalità
`FIRESTORE_NATIVE`, regione **`eur3`** (multi-regione UE), e regole del repository pubblicate.
Per un nuovo ambiente:

1. Console Firebase → **Firestore Database** → **Create database**.
2. Scegliere la **regione** (una sola volta, non modificabile): per l'Italia una regione UE
   (es. `eur3` / `europe-west8` / `europe-west1`). La scelta va riportata nell'informativa privacy.
3. Modalità: **production mode** (le regole del repository limitano già l'accesso).
4. Pubblicare le regole:

```bash
firebase deploy --only firestore:rules
```

Le regole in `firestore.rules` consentono a ogni utente di leggere/scrivere solo
`users/{uid}` e le relative subcollection. Il documento utente contiene `email`,
`displayName`, `settings.autoSave`, il record `keyVault` (chiave cifrata) e i timestamp
`createdAt`/`updatedAt`. Analisi e profili disattivati sono memorizzati solo come payload
cifrato (`enc`) con ID opachi (vedi sezione 10).

Senza database o regole pubblicate il login funziona ma analisi e profili disattivati
restano nella cache locale (`local-fallback`) e l'interfaccia mostra un avviso con "Riprova".

## 3. Domini autorizzati

Console Firebase → **Authentication** → **Settings** → **Authorized domains**.
Verificare che siano presenti:

- dominio di produzione (es. `instagram-follower-tracker.com`);
- dominio Firebase Hosting (`igfollowertracking-v2.web.app`, `*.firebaseapp.com`);
- `localhost` (presente di default, serve per lo sviluppo).

I preview channel usano domini `*.web.app` già coperti dal wildcard Firebase, ma verificare
in caso di domini personalizzati.

## 4. Deploy hosting

```bash
firebase deploy --only hosting
```

La pipeline GitHub Actions (`.github/workflows/main.yml`) deploya su push verso `main`
con il secret `GCP_SA_KEY`.

## 5. Branch `dev` e anteprima

Il branch `dev` non è collegato a un deploy automatico: si evita di pubblicare su produzione
prima della validazione.

Opzioni per provare il branch:

- **Preview channel** (richiede piano Blaze):
  ```bash
  firebase hosting:channel:deploy dev --project igfollowertracking-v2 --expires 14d
  ```
- **Emulatori locali** (consigliato, nessun costo):
  ```bash
  firebase emulators:start --only auth,firestore,hosting
  ```
- **Server statico locale** con configurazione manuale (vedi sotto).

### Configurazione per hosting non-Firebase

Su `http://localhost` con un server statico qualsiasi `/__/firebase/init.json` non esiste.
Creare `public/scripts/firebase-config.js` (file ignorato da git) con:

```js
window.IGFT_FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "igfollowertracking-v2.firebaseapp.com",
  projectId: "igfollowertracking-v2",
  appId: "..."
};
```

e includerlo sia in `index.html` sia in `login.html`, prima di `scripts/firebase-init.js`.
In alternativa, da console del browser:

```js
localStorage.setItem('igft.firebaseConfig', JSON.stringify({ /* stessi campi */ }));
```

Questi valori sono pubblici per natura (non sono segreti), ma è buona norma non versionarli.

## 6. Verifica funzionale

Checklist dopo il deploy:

1. Modalità ospite: analisi ZIP, marcatura "Disattivato", ricaricamento pagina → il profilo
   resta marcato (localStorage) e viene escluso dalla nuova analisi.
2. Registrazione email/password: arrivo email di verifica; login; la cassaforte viene creata
   automaticamente dalla password; analisi salvata.
3. Ricaricamento su un altro browser/dispositivo: sblocco con la password dell'account; storico
   e profili disattivati presenti.
4. In console Firebase i documenti di `analyses` e `deactivated` contengono solo `enc` (testo
   cifrato) e ID opachi: nessuna username in chiaro.
5. Eliminazione singola analisi, eliminazione account e dati.
6. Disattivazione del salvataggio automatico: la nuova analisi non compare nello storico.
7. Regole Firestore: un utente non può leggere i dati di un altro (verifica con REST/emulator).

## 7. Costi e manutenzione

- Firestore: ogni analisi salvata consuma 1 scrittura per il documento + 1 per blocco da 900
  username (circa 12 scritture per 10.000 profili). La lettura dello storico paginato consuma
  una lettura per analisi elencata.
- Impostare un **budget alert** in Google Cloud.
- Le analisi sono mantenute finché l'utente non le elimina; non è prevista al momento una
  retention automatica. Se necessario, valutare un job schedulato di pulizia.

## 8. Privacy

L'attivazione dell'area personale introduce un trattamento su server: l'informativa privacy
(`public/privacy-policy.html`) è stata aggiornata con finalità, dati trattati, conservazione,
fornitore (Google Firebase) e modalità di cancellazione. La modalità ospite resta locale.

## 9. Troubleshooting sincronizzazione

La console del browser non deve mostrare errori quando Firestore non è raggiungibile: l'app
resta utilizzabile con la cache locale e le modifiche vengono messe in coda. Una singola riga
informativa del tipo `[IGFT] sincronizzazione Firestore in background ...` è attesa e non
richiede azioni.

Se compare, verificare in ordine:

1. **Firestore API abilitata** nel progetto Google Cloud:
   ```bash
   gcloud services enable firestore.googleapis.com --project igfollowertracking-v2
   firebase firestore:databases:list --project igfollowertracking-v2
   ```
   Se il comando restituisce `403` con "Cloud Firestore API has not been used", la API non è
   attiva e la console Firebase **non** può creare il database: abilitarla prima.
2. **Database creato** (sezione 2) nella regione scelta: finché non esiste, ogni lettura resta
   in attesa fino al timeout e l'app continua in locale.
3. **Regole pubblicate** (`firebase deploy --only firestore:rules`): un errore di permessi è
   invece mostrato in interfaccia con il pulsante "Riprova".
4. **Rete/proxy**: se Firestore è raggiungibile ma lento, l'app ritenta da sola con backoff
   (1, 2, 4, 8 minuti) senza bloccare l'interfaccia.

Nota: per gli utenti autenticati Firestore è la fonte di verità: analisi e profili
disattivati vengono scritti e riletti dal database, mentre localStorage resta solo una cache
per l'uso offline. Le modifiche salvate senza rete vengono inviate automaticamente al
ripristino della connessione (con backoff).

## 10. Cifratura automatica

Analisi e profili disattivati non vengono mai scritti in chiaro su Firestore. La cifratura è
interamente lato client (Web Crypto API), è attiva per impostazione predefinita e non richiede
servizi aggiuntivi né azioni dell'utente.

### Schema

| Elemento | Dove | Contenuto |
| --- | --- | --- |
| `users/{uid}.keyVault` | Firestore | `{v, kdf, iterations, salt, iv, wrappedKey}` (+ `autoSecret` per gli account Google): DEK avvolta con la KEK |
| `users/{uid}/analyses/{id}` | Firestore | `{createdAt, enc}` |
| `users/{uid}/analyses/{id}/items/chunk-NNN` | Firestore | `{enc}` (array di username cifrato) |
| `users/{uid}/deactivated/{docId}` | Firestore | `{enc}` con `docId = HMAC-SHA256(username)` |

Algoritmi: AES-GCM 256 con IV casuale per valore; PBKDF2-SHA256 con 310.000 iterazioni per la
KEK; HKDF-SHA256 per la chiave di deduplicazione. Dettagli e trade-off in
`docs/adr/ADR-002-zero-knowledge-cifratura.md`.

### Flusso utente

1. Alla registrazione e a ogni login la cassaforte viene creata o aperta **automaticamente**:
   nessuna attivazione, nessuna frase aggiuntiva.
2. Account email/password: la KEK è derivata dalla password dell'account (zero-knowledge). La
   pagina di login esegue l'operazione prima del redirect e salva la chiave in IndexedDB come
   `CryptoKey` non estraibile.
3. Account Google: l'app genera un `autoSecret` casuale, lo usa come KEK e lo salva nel record
   `keyVault`; la cassaforte si apre da sola su ogni dispositivo. I dati restano cifrati nel
   database, ma questa modalità non è zero-knowledge in senso stretto.
4. Finché la chiave non è disponibile non viene letto né scritto nulla di sensibile sul
   database: le analisi restano locali e vengono accodate, poi sincronizzate automaticamente.

### Deploy delle regole

Le regole aggiornate vanno pubblicate perché i nuovi payload `{enc}` siano accettati:

```bash
firebase deploy --only firestore:rules --project igfollowertracking-v2
```

Le regole continuano a consentire la **lettura/eliminazione** dei documenti legacy in chiaro
(scritture nuove solo nel formato cifrato). La migrazione automatica avviene al primo sync con
chiave sbloccata.

### Limiti accettati

- Account email/password: se la password viene persa, i dati cifrati sono **irrecuperabili**:
  nessuno, nemmeno l'amministratore, possiede la chiave. La reimpostazione via email permette di
  rientrare nell'account ma non recupera i dati cifrati con la vecchia password.
- Account Google: l'`autoSecret` salvato nel profilo consente l'apertura automatica; i dati sono
  cifrati nel database ma questa modalità non è zero-knowledge in senso stretto.
- Restano leggibili i metadati minimi: email/nome del profilo, data dell'analisi, ID e numero
  dei documenti.