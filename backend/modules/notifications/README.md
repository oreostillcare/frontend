# P — Notifications

The website alarm is handled by the Next.js notification provider. Warning observations and critical events are sent server-side through Mailjet to active, non-archived staff; informational and retry events remain in Firestore without email delivery. Shared application email templates are stored in the Firestore `emailTemplates` collection by running `npm run seed:email-templates`.

Templates:

- `system-alert` — information, warning, and critical system events.
- `major-event` — persistent critical failures and compromised-node alerts.
