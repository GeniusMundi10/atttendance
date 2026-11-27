-- PURPOSE: Schedule the serverless WhatsApp sender in this Supabase environment.
-- Run once per environment after setting the Vault secrets documented in DEPLOYMENT.md.
DO $setup$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets
                 WHERE name = 'elt_attendance_origin' AND decrypted_secret ~ '^https://[a-zA-Z0-9.-]+/?$')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets
                    WHERE name = 'elt_whatsapp_cron_secret' AND length(decrypted_secret) > 0) THEN
    RAISE EXCEPTION 'Configure the attendance HTTPS origin and WhatsApp cron secret in Vault first';
  END IF;

  PERFORM cron.schedule('elt-whatsapp-outbox', '* * * * *', $job$
    SELECT net.http_post(
      url := rtrim((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'elt_attendance_origin'), '/')
             || '/api/internal/whatsapp',
      headers := jsonb_strip_nulls(jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'elt_whatsapp_cron_secret'),
        'x-vercel-protection-bypass', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'elt_vercel_protection_bypass')
      )),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$);
END;
$setup$;
