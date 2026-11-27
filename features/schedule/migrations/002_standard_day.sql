-- PURPOSE: ELT's standard day is 9:30 AM to 6:00 PM (8.5 hours); everyone without an explicit assignment follows it.
UPDATE schedule_shifts SET required_minutes = 510, half_day_minutes = 255
WHERE id = '6f1d0c1e-5a52-4f0e-9a39-0a1b8f3c2d01';
