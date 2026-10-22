# Rentify CRM Core (Technical Showcase)

This demonstration repository showcases key architectural components of a rental management automation system. The application is built as an **offline-first desktop app** with cloud synchronization.

## Tech Stack
- **Backend:** Python 3.10, Django, Django REST framework, PostgreSQL
- **Desktop:** Node.js, Electron, SQLite
- **Integrations:** Google Cloud Vision API (OCR), Sigex (Kazakhstan digital signature / EDS), Kaspi POS API
- **DevOps:** Docker, Nginx, Gunicorn

## Key Architectural Highlights

### 1. Smart Data Synchronization
Implements an incremental sync engine between local SQLite instances and the central PostgreSQL database. Django views use `transaction.atomic` to guarantee atomicity during batch uploads from remote branches and client terminals.

### 2. Security & Hardware Licensing
Features a node licensing mechanism bound to physical hardware via unique HWID generation (`os.hostname` + system user parameters), paired with Bearer token authentication for secure API communication.

### 3. Identity Verification & Automation (OCR & eGov)
- **ID Processing:** Integrates Google Cloud Vision OCR to extract identity card data (regex-based parsing for Kazakhstani National Identification Numbers [IIN], issue dates, and full names).
- **Compliance Checks:** Automatically validates customer records against eGov public debtor registries using SOAP and REST protocols.

### 4. Real-Time Recalculation Engine
An in-memory billing engine runs on the desktop renderer process to calculate rental totals in real time, handling multi-tier pricing matrices, dynamic rental durations, and automated discount schemes.
