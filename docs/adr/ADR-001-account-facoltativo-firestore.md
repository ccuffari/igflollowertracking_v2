# ADR-001 — Account facoltativo, storico analisi e memoria dei profili disattivati

- **Stato:** Accepted
- **Data:** 2026-11-12
- **Contesto:** branch `dev` di Instagram Follower Tracker (web app statica su Firebase Hosting)
- **Owner:** CTO
- **Aggiornamento:** il modello dati su Firestore è stato reso cifrato e automatico da
  [ADR-002](ADR-002-zero-knowledge-cifratura.md): analisi e profili disattivati sono cifrati
  nel browser e il database non contiene username in chiaro.

## Contesto

L'app attuale è interamente client-side: il file ZIP viene letto nel browser e nessun dato
lascia il dispositivo. Il sito dichiara "elaborazione offline" e "dati non salvati".

La nuova versione deve:

1. introdurre login/registrazione **facoltativi** con Firebase Auth, mantenendo il flusso
   ospite identico a oggi;
2. consentire all'utente autenticato di consultare le analisi passate;
3. consentire di marcare, dopo un'analisi, i profili disattivati; la marcatura deve persistere
   e i profili devono essere esclusi automaticamente dai report successivi.

## Decisione

- **Firebase Authentication** con provider Email/Password e Google. Nessun backend custom.
- **Cloud Firestore** come storage per utente, con regole di sicurezza owner-only.
- **Firestore è la fonte di verità per gli utenti autenticati**: analisi e profili disattivati
  vengono scritti e riletti dal database a ogni accesso. **localStorage** resta lo storage
  della modalità ospite e una cache per l'uso offline; le modifiche fatte senza rete vengono
  accodate e sincronizzate automaticamente. Il database predefinito `(default)` del progetto
  `igfollowertracking-v2` è attivo in regione `eur3`.
- **Astrazione `IGFTStore`** con due backend dietro la stessa API (`markDeactivated`,
  `saveAnalysis`, `getAnalysis`, ...): il resto dell'app non conosce il backend attivo.
- **Modello dati**:
  - `users/{uid}` - profilo (`email`, `displayName`) e impostazioni (`settings.autoSave`);
  - `users/{uid}/deactivated/{username}` - memoria dei profili disattivati;
  - `users/{uid}/analyses/{id}` - metadati del report;
  - `users/{uid}/analyses/{id}/items/chunk-NNN` - username in blocchi da 900
    (evita il limite di 1 MiB per documento).
- **Filtro dei disattivati al momento dell'analisi**, non a ogni render: la marcatura fatta
  dopo un'analisi resta visibile nel report corrente con badge "disattivato" e viene esclusa
  a partire dall'analisi successiva, come richiesto.
- **Configurazione Firebase da `/__/firebase/init.json`** (Hosting), con override opzionale
  per sviluppo locale; nessun segreto nel repository.
- **Degrado controllato**: se Firebase/Firestore non è disponibile, l'app continua a
  funzionare con la cache locale e mostra lo stato "modifiche in coda"; al ritorno della
  connessione i dati vengono sincronizzati con il database.

## Alternative valutate

| Alternativa | Perché scartata |
| --- | --- |
| Solo localStorage (nessun account) | Non soddisfa il requisito di storico accessibile da più dispositivi né la sincronizzazione dei profili disattivati. |
| Backend custom (API + DB) | Costo operativo e superficie di sicurezza maggiori per un'app statica con un solo requisito CRUD. |
| Realtime Database | Modello gerarchico e query meno adatte; Firestore è più adatto a documenti per analisi e regole owner-only semplici. |
| Firebase Auth anonimo + link account | UX più complessa e non richiesta; l'accesso facoltativo con email/Google copre il caso d'uso. |
| Salvataggio dell'intero file/follower | Non necessario e contrario alla minimizzazione: si salvano solo gli username del report. |

## Conseguenze

Positive:

- Nessun server da mantenere; scalabilità e disponibilità delegate a Firebase.
- Stessa esperienza per gli ospiti; valore aggiunto per gli utenti autenticati.
- Regole di sicurezza dichiarative e verificabili.

Negative / rischi:

- **Privacy**: i dati lasciano il dispositivo per gli utenti autenticati. Mitigazione:
  informativa privacy aggiornata, consenso tramite scelta esplicita di accedere, toggle per
  disattivare il salvataggio automatico, cancellazione puntuale e totale dall'area personale,
  nessun salvataggio del file ZIP.
- **Costi variabili**: Firestore a consumo. Mitigazione: chunk ragionevoli, limite di 100
  analisi elencate, budget alert, documentazione in `docs/FIREBASE_SETUP.md`.
- **Dipendenze esterne**: SDK Firebase da CDN. Mitigazione: versione pinnata (10.12.5) e
  degradazione a modalità ospite se il caricamento fallisce.
- **Regole non deployate**: il salvataggio cloud fallisce. Mitigazione: fallback locale,
  avviso esplicito con azione "Riprova" e checklist di setup.
- **Dati di terzi** (username di profili Instagram): base giuridica e informativa aggiornate;
  i dati sono limitati agli username già presenti nel report dell'utente.

## Follow-up

- Valutare una retention automatica per le analisi più vecchie (job schedulato).
- Valutare l'export dei propri dati (portabilità) dall'area personale.
- Valutare MFA o verifica email bloccante se il servizio evolve in SaaS.
- Aggiungere test end-to-end con Firebase Emulator Suite in CI.
