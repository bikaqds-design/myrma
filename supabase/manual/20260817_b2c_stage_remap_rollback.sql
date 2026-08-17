-- Rollback for the B2C pipeline normalisation of 2026-08-17.
--
-- Two changes were made that day, in order. Running this whole file undoes
-- both and returns the B2C Retail Pipeline to its prior state; run only the
-- first statement to undo the stage remap alone.
--
-- == 1. The stage remap ==================================================
--
-- On that date 24 deals on the B2C Retail Pipeline were sitting in stages the
-- pipeline does not define — new_lead (13), negotiation (6) and
-- needs_assessment (5), all three B2B-only. They were remapped:
--
--     new_lead         -> new_inquiry   (probability 10, unchanged)
--     needs_assessment -> contacted     (probability 40 -> 30)
--     negotiation      -> quote_sent    (probability 75 -> 60)
--
-- Every one was status = 'open', so no won_at / lost_at / lost_reason was
-- touched. Running this file restores the stage and probability each deal held
-- before the remap. It does not restore updated_at, which the remap advanced.
--
-- This is a data repair, not a schema change, and is deliberately NOT in
-- supabase/migrations — it must never replay against another environment.

UPDATE deals AS d
SET stage = v.stage, probability = v.prob, updated_at = now()
FROM (VALUES
  ('118dafaf-e6a1-4f95-8a19-0efe29add3da'::uuid, 'needs_assessment', 40),
  ('12956cc2-5787-443d-94af-f5b40865d784'::uuid, 'needs_assessment', 40),
  ('2c9aa7cd-0ed3-4e1c-a0ac-496671250b7b'::uuid, 'needs_assessment', 40),
  ('3e41add3-1db4-41d6-81b4-9cacc016bb4d'::uuid, 'needs_assessment', 40),
  ('d26235e3-5ce1-4285-adc5-cb6183cf5f81'::uuid, 'needs_assessment', 40),
  ('0e7a7014-247f-4ff0-b9c4-243b96683ec9'::uuid, 'negotiation', 75),
  ('5c8d3c47-b137-485d-a270-754fca825fcf'::uuid, 'negotiation', 75),
  ('67fc1e2d-ab60-4783-943d-b1242bc94bea'::uuid, 'negotiation', 75),
  ('8c4e3f60-d1ed-40d3-8252-f56b90bdf9a9'::uuid, 'negotiation', 75),
  ('c5faaf89-df35-41fa-b9e8-18a805aafc8c'::uuid, 'negotiation', 75),
  ('feb7d0d4-6d7b-42db-bfd9-77dce4d8191e'::uuid, 'negotiation', 75),
  ('24d665e9-93a0-4f68-b1fd-191148358249'::uuid, 'new_lead', 10),
  ('27cc81e6-ea1d-4f3b-af53-d07d3c46c43f'::uuid, 'new_lead', 10),
  ('30d9d4ec-4368-4b42-a667-9b21098a8f14'::uuid, 'new_lead', 10),
  ('31d3d852-bcf2-4fe8-841f-d67a58b7a172'::uuid, 'new_lead', 10),
  ('321eec9e-941c-4d01-a251-5684e3703055'::uuid, 'new_lead', 10),
  ('3872d9f7-282d-424b-ab50-a31d251e7d5f'::uuid, 'new_lead', 10),
  ('89422269-f8ac-4aa1-a3b3-c7d8ac11a25d'::uuid, 'new_lead', 10),
  ('9771112b-7c12-408c-8fa5-68a683396e4f'::uuid, 'new_lead', 10),
  ('9af8cece-59c4-4c48-b12f-43a4536d284f'::uuid, 'new_lead', 10),
  ('cc265108-a14f-4fff-befd-693cb31a8008'::uuid, 'new_lead', 10),
  ('e4e6b42b-cf49-4344-95a7-e446c53ab09c'::uuid, 'new_lead', 10),
  ('efc1c5c5-80fd-4c5e-8100-e8f780dcf2da'::uuid, 'new_lead', 10),
  ('f9ec5644-b023-48bc-ace7-d9f34d331cdb'::uuid, 'new_lead', 10)
) AS v(id, stage, prob)
WHERE d.id = v.id;

-- == 2. The probability normalisation ====================================
--
-- Seven deals that were already sitting in `contacted` — never mis-staged, and
-- outside the remap above — carried probability 20 while that stage's default
-- on this pipeline is 30. All seven were uniformly at 20 and all were
-- status = 'open', consistent with the same SQL seeding that produced the 24:
-- 20 is the B2B pipeline's contacted default, not the B2C one. They were set
-- to 30 so the column no longer weights identical deals differently.
--
-- Deliberately NOT included: five B2B deals whose probabilities also differ
-- from their stage defaults (0, 33, 100). Those values are varied rather than
-- uniform, so they look hand-set rather than inherited, and flattening them
-- would destroy a judgement somebody may have made.

UPDATE deals AS d
SET probability = v.prob, updated_at = now()
FROM (VALUES
  ('fbc3cab0-76d2-452e-828c-f4ef1ba42f11'::uuid, 20),
  ('295df6d9-5fd3-4966-8d94-b89495d52653'::uuid, 20),
  ('59ad2584-971e-476b-bc8f-eeaee4a47e8a'::uuid, 20),
  ('b1f9d38b-ae81-4960-ac85-866dd6c4b799'::uuid, 20),
  ('ded3d721-e5ef-44f3-a1c7-caf902587313'::uuid, 20),
  ('e91a3d9b-9c2e-4b31-abae-c5d42d1770e1'::uuid, 20),
  ('ac937b40-e964-480a-9d8f-e70ec9203cee'::uuid, 20)
) AS v(id, prob)
WHERE d.id = v.id;
