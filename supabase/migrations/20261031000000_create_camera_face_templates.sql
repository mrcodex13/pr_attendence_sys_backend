create table if not exists public.camera_face_templates (
  organization_id text not null,
  person_id text not null,
  ciphertext text not null,
  iv text not null,
  tag text not null,
  model_version varchar(80) not null,
  enrolled_by_user_id text not null,
  enrolled_at timestamptz not null default now(),
  primary key (organization_id, person_id)
);

alter table public.camera_face_templates enable row level security;

revoke all on table public.camera_face_templates from anon, authenticated;
grant all on table public.camera_face_templates to service_role;
