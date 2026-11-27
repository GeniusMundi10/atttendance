<!-- PURPOSE: Describe the correction workflow and feature-owned PostgreSQL test. -->
# Attendance corrections

Employees submit one or more IST work dates with proposed IN, OUT, or both and a reason. A date remains reserved while pending or approved. Each employee may hold three distinct dates in each IST calendar month. Rejection releases the date. A manager assigned to the employee, or an HR/admin user with MFA, decides each date with an override reason. Each decision checks the displayed revision. Original kiosk punches remain immutable; approved values appear in the effective day view with correction provenance.

Run the feature suite with a dedicated PostgreSQL test database:

```sh
CORRECTIONS_TEST_DATABASE_URL=postgres://... node --experimental-strip-types --test features/corrections/corrections.test.ts
```

`npm run test:features` starts disposable PostgreSQL and supplies the test URL. The feature suite uses a temporary schema and synthetic identities.
