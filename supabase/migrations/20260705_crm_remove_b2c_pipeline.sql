-- Remove B2C Retail pipeline and all its deals/activities.
-- B2C customers are served by the RMA tickets system, not the CRM pipeline.
-- Rename the remaining B2B Dealer pipeline to "Sales Pipeline".

-- 1. Delete activities linked to deals in the B2C pipeline
DELETE FROM activities
WHERE related_type = 'deal'
  AND related_id IN (
    SELECT id FROM deals
    WHERE pipeline_id = (SELECT id FROM pipelines WHERE name = 'B2C Retail' LIMIT 1)
  );

-- 2. Delete deals in the B2C pipeline
DELETE FROM deals
WHERE pipeline_id = (SELECT id FROM pipelines WHERE name = 'B2C Retail' LIMIT 1);

-- 3. Delete the B2C pipeline itself
DELETE FROM pipelines WHERE name = 'B2C Retail';

-- 4. Rename B2B Dealer → Sales Pipeline
UPDATE pipelines SET name = 'Sales Pipeline' WHERE name = 'B2B Dealer';
