-- Playbook rules scoped by document type + the NDA rule set.
-- Run in the Varda Supabase SQL editor — NOT Lovable. Idempotent.
--
-- applies_to = NULL  → rule applies to every document type (GP3, GP5)
-- applies_to = {...} → rule is only scored for those reviews.document_type values
--                      ('PKS','LOI','NDA','Client Template','Other')

alter table public.playbook_rules
  add column if not exists applies_to text[] null;

-- 1) Existing service-contract rules: everything except the two universal
--    general principles is scoped away from NDAs.
update public.playbook_rules
   set applies_to = array['PKS','LOI','Client Template','Other']
 where applies_to is null
   and rule_number not in ('GP3','GP5');

-- 2) NDA rule set (agreed 2026-09-22). rule_number is unique, so re-running is safe.
insert into public.playbook_rules (rule_number, title, description, thresholds, severity, is_active, applies_to) values
('NDA 1',  'Mutuality of obligations',
 'Obligations must be mutual whenever both parties disclose (clients, vendors, partners). A one-way NDA is acceptable ONLY when Dash is the disclosing party (typical for investors). Flag any NDA where Dash is the receiving party and the only party bound.',
 '{}'::jsonb, 'HIGH', true, array['NDA']),
('NDA 2',  'Definition of Confidential Information',
 'Definition must be broad: written, oral and visual information, information not marked confidential, and DERIVED data (route optimisation, operational data, pricing, client lists, volumes). Standard exclusions must exist: public domain, already known, independently developed, lawfully received from a third party.',
 '{}'::jsonb, 'HIGH', true, array['NDA']),
('NDA 3',  'Purpose limitation',
 'Information may be used only to evaluate or perform the stated transaction. No reverse engineering, no use of Dash pricing or operational data for benchmarking or tenders with competitors, no use to develop competing services.',
 '{}'::jsonb, 'HIGH', true, array['NDA']),
('NDA 4',  'Term and survival',
 'NDA term ideally 2-3 years. Confidentiality obligations MUST survive termination or expiry for at least 2 years; trade secrets indefinitely. CRITICAL if obligations end when the agreement ends or if no survival clause exists.',
 '{"min_survival_years": 2, "ideal_term_years_min": 2, "ideal_term_years_max": 3}'::jsonb, 'CRITICAL', true, array['NDA']),
('NDA 5',  'Permitted disclosures',
 'Disclosure to employees, affiliates and professional advisers is acceptable on a need-to-know basis bound by equivalent obligations. Disclosure compelled by law, regulator or court with prior notice (where legally permitted) is a NORMAL exception — do not flag it. Flag if the recipient may share with unnamed third parties or portfolio companies without equivalent obligations.',
 '{}'::jsonb, 'MEDIUM', true, array['NDA']),
('NDA 6',  'Return or destruction',
 'On request or termination the recipient must return or destroy confidential information and confirm in writing. Reasonable carve-outs for routine backups and legally required retention are acceptable.',
 '{}'::jsonb, 'MEDIUM', true, array['NDA']),
('NDA 7',  'Remedies, penalties and liability',
 'Injunctive relief must be available to the disclosing party. NO fixed penalty (denda), liquidated damages or unlimited indemnity imposed on Dash. Indirect, consequential and punitive losses must be excluded. CRITICAL if a penalty clause binds Dash.',
 '{}'::jsonb, 'CRITICAL', true, array['NDA']),
('NDA 8',  'No non-compete; limited non-solicit',
 'Dash serves many clients in the same categories: NO non-compete or exclusivity may be imposed on Dash through an NDA. Employee non-solicitation is acceptable only if mutual and limited to 12 months. CRITICAL if a non-compete binds Dash.',
 '{"max_non_solicit_months": 12}'::jsonb, 'CRITICAL', true, array['NDA']),
('NDA 9',  'No obligation to transact, no licence, no warranty',
 'The NDA must state that neither party is obliged to enter into a further transaction, that no licence or IP right is granted by disclosure, and that information is provided as-is without warranty. Flag if missing (protects Dash as discloser).',
 '{}'::jsonb, 'MEDIUM', true, array['NDA']),
('NDA 10', 'Personal data (UU PDP 27/2022)',
 'If personal data (recipient names, addresses, phone numbers of a client''s customers) may flow between the parties, the NDA must reference compliance with UU 27/2022 on Personal Data Protection, allocate controller/processor roles and require breach notification. Flag if personal data is in scope and no PDP clause exists.',
 '{}'::jsonb, 'HIGH', true, array['NDA']),
('NDA 11', 'Governing law, forum and language',
 'Indonesian law; disputes preferably BANI arbitration in Jakarta (Indonesian courts acceptable). For bilingual drafts the Indonesian text must prevail (UU 24/2009). Flag foreign law, foreign courts or English-prevails clauses.',
 '{}'::jsonb, 'HIGH', true, array['NDA']),
('NDA 12', 'Termination is acceptable when confidentiality survives',
 'Either party may terminate on notice; this is NOT a red flag for an NDA. Only flag termination if it also ends confidentiality obligations (see NDA 4) or if only the counterparty may terminate.',
 '{}'::jsonb, 'MEDIUM', true, array['NDA']),
('NDA 13', 'No hidden deal terms',
 'An NDA must not contain exclusivity, standstill, right of first refusal, most-favoured terms, minimum commitments or pricing commitments. CRITICAL if any commercial obligation beyond confidentiality is embedded.',
 '{}'::jsonb, 'CRITICAL', true, array['NDA']),
('NDA 14', 'Investor specifics: residuals and portfolio carve-outs',
 'For investor NDAs: flag "residuals" clauses that let the recipient freely use information retained in unaided memory. Portfolio-company or affiliate carve-outs are acceptable only with information barriers and no disclosure of Dash information to competing portfolio companies.',
 '{}'::jsonb, 'HIGH', true, array['NDA']),
('NDA 15', 'Ownership of information and feedback',
 'Disclosed information remains the property of the disclosing party. Any feedback, ideas or improvements derived from Dash information must not create rights for the recipient.',
 '{}'::jsonb, 'MEDIUM', true, array['NDA'])
on conflict (rule_number) do nothing;

-- Verify:
--   select rule_number, severity, applies_to from public.playbook_rules order by rule_number;
--   expect GP3/GP5 → NULL, RULE*/GP1/GP2/GP4 → {PKS,LOI,"Client Template",Other}, NDA 1..15 → {NDA}
