-- Owed: seed the 6 demo vendors. Safe to re-run (upsert on name).
-- terms_verified=false means the SLA tiers are DEMO TERMS; verify against the sla_url before claiming otherwise.
insert into vendors (name, monthly_spend, sla_url, status_url, sla_target, sla_tiers, terms_verified) values
('AWS',     12000, 'https://aws.amazon.com/compute/sla/',                                            'https://health.aws.amazon.com/health/status', 99.99,
  '[{"below":99.99,"credit_pct":10},{"below":99.0,"credit_pct":30},{"below":95.0,"credit_pct":100}]', true),
('Twilio',   4500, 'https://www.twilio.com/en-us/legal/service-level-agreement',                      'https://status.twilio.com',                   99.95,
  '[{"below":99.95,"credit_pct":10},{"below":99.0,"credit_pct":25}]', false),
('Datadog',  6000, 'https://www.datadoghq.com/legal/service-level-agreement/',                        'https://status.datadoghq.com',                99.9,
  '[{"below":99.9,"credit_pct":10},{"below":99.0,"credit_pct":25}]', false),
('Slack',    3200, 'https://slack.com/terms-of-service/service-level-agreement',                     'https://slack-status.com',                    99.99,
  '[{"below":99.99,"credit_pct":10},{"below":99.0,"credit_pct":25}]', false),
('Vercel',   2500, 'https://vercel.com/legal/sla',                                                    'https://www.vercel-status.com',               99.99,
  '[{"below":99.99,"credit_pct":10},{"below":99.0,"credit_pct":25}]', false),
('GitHub',   2000, 'https://github.com/customer-terms/github-enterprise-service-level-agreement',     'https://www.githubstatus.com',                99.9,
  '[{"below":99.9,"credit_pct":10},{"below":99.0,"credit_pct":25}]', false)
on conflict (name) do update set
  monthly_spend = excluded.monthly_spend,
  sla_url = excluded.sla_url,
  status_url = excluded.status_url,
  sla_target = excluded.sla_target,
  sla_tiers = excluded.sla_tiers,
  terms_verified = excluded.terms_verified;
