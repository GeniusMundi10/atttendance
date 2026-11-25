-- PURPOSE: Reap expired kiosk protocol state outside the punch transaction.
DELETE FROM kiosk_face_enrollment_codes WHERE expires_at < statement_timestamp();
DELETE FROM kiosk_biometric_challenges WHERE expires_at < statement_timestamp() - INTERVAL '10 minutes';
DELETE FROM kiosk_biometric_requests WHERE received_at < statement_timestamp() - INTERVAL '10 minutes';
DELETE FROM kiosk_face_enrollment_limits WHERE bucket_start < statement_timestamp() - INTERVAL '7 days';
