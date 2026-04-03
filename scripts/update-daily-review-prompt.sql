-- Update the daily-review prompt to include problem observations
-- Run this in the Supabase SQL editor AFTER seeding extract-problems

UPDATE prompts SET
  system_prompt = regexp_replace(
    system_prompt,
    E'## Known Projects\\n\\{\\{project_list\\}\\}',
    E'## Known Projects\n{{project_list}}\n\n## Known Problems\n{{problems_list}}',
    'g'
  ),
  system_prompt = regexp_replace(
    system_prompt,
    E'"review_summary": "2-3 sentence summary of the day''s key outcomes and themes"\\n\\}',
    E'"problem_observations": [\n    { "problem_id": "P1", "observation": "What was observed relating to this problem", "evidence_type": "customer_quote|workflow_gap|market_data|interview_insight", "source_context": "Which meeting or note" }\n  ],\n  "review_summary": "2-3 sentence summary of the day''s key outcomes and themes"\n}',
    'g'
  ),
  version = version + 1,
  updated_at = now()
WHERE slug = 'daily-review';
