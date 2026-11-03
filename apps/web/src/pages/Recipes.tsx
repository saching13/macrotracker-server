import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Schemas, unwrap } from '../api/client';
import { OrbLoader, Section, Sheet, SmallOrb } from '../components/ui';
import { energyLabel, formatEnergyNumber, trim } from '../format';

type Shared = Schemas['SharedRecipe'];

function useEnergyUnit() {
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => unwrap(api.GET('/v1/profile')) });
  return profile.data?.profile?.unit_energy ?? 'kcal';
}

const perServing = (r: { total_kcal: number; servings: number }) =>
  r.total_kcal / (r.servings > 0 ? r.servings : 1);

export function RecipesPage() {
  const energy = useEnergyUnit();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Shared | null>(null);
  const mine = useQuery({ queryKey: ['recipes'], queryFn: () => unwrap(api.GET('/v1/recipes')) });
  const library = useQuery({
    queryKey: ['library', q.trim()],
    queryFn: () =>
      unwrap(api.GET('/v1/library', { params: { query: { q: q.trim() || undefined, limit: 50 } } })),
  });
  const share = useMutation({
    mutationFn: (recipe_id: string) => unwrap(api.POST('/v1/library', { body: { recipe_id } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library'] }),
  });
  // Recipes already in the library (among those listed) offer an update.
  const sharedFrom = new Set((library.data?.recipes ?? []).map((r) => r.from_recipe_id).filter(Boolean));

  return (
    <>
      <h1>Recipes</h1>
      <Section
        header="Your recipes"
        footer="Build recipes in the app. Sharing puts a copy in the library for everyone on this server; recipes with INDB foods can’t be shared."
      >
        {mine.isPending && <OrbLoader message="Loading your recipes…" />}
        {(mine.data?.recipes ?? []).map((r) => (
          <div className="row" key={r.id}>
            <span className="grow">
              <div className="name">{r.name}</div>
              <div className="secondary small">
                {formatEnergyNumber(perServing(r), energy)} {energyLabel(energy)} per serving ·{' '}
                {trim(r.servings)} {r.servings === 1 ? 'serving' : 'servings'}
              </div>
            </span>
            <button
              className="button tonal"
              type="button"
              disabled={share.isPending && share.variables === r.id}
              onClick={() => share.mutate(r.id)}
            >
              {sharedFrom.has(r.id) ? 'Update shared' : 'Share'}
            </button>
          </div>
        ))}
        {mine.data?.recipes.length === 0 && <div className="row secondary">No recipes yet.</div>}
      </Section>
      {share.isError && <p className="error">{share.error.message}</p>}

      <h2 className="section-header">Shared library</h2>
      <input
        className="input"
        type="search"
        placeholder="Search recipes or people"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search the shared library"
      />
      <div className="card" style={{ marginTop: 'var(--space-m)' }}>
        {library.isFetching && !library.data && <OrbLoader message="Loading the library…" />}
        {(library.data?.recipes ?? []).map((r) => (
          <button
            className="row"
            type="button"
            key={r.id}
            onClick={() => setOpen(r)}
            data-testid="shared-recipe"
          >
            <span className="grow">
              <div className="name">{r.name}</div>
              <div className="secondary small">
                {r.mine ? 'Shared by you' : `by ${r.shared_by}`} · {formatEnergyNumber(perServing(r), energy)}{' '}
                {energyLabel(energy)} per serving{r.added_as ? ' · added' : ''}
              </div>
            </span>
          </button>
        ))}
        {library.data?.recipes.length === 0 && (
          <div className="row secondary">
            {q.trim() ? 'No recipes match.' : 'Nobody has shared a recipe yet.'}
          </div>
        )}
      </div>
      {open && <SharedSheet recipe={open} energy={energy} onClose={() => setOpen(null)} />}
    </>
  );
}

function SharedSheet({ recipe, energy, onClose }: { recipe: Shared; energy: string; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all(['library', 'recipes'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const add = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/library/{id}/copy', { params: { path: { id: recipe.id } } })),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/v1/library/{id}', { params: { path: { id: recipe.id } } })),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const s = recipe.servings > 0 ? recipe.servings : 1;
  return (
    <Sheet title={recipe.name} onClose={onClose}>
      <p className="secondary">
        {recipe.mine ? 'Shared by you' : `Shared by ${recipe.shared_by}`} · {trim(recipe.servings)}{' '}
        {recipe.servings === 1 ? 'serving' : 'servings'}
        {recipe.total_weight_g ? ` · ${Math.round(recipe.total_weight_g)} g` : ''}
      </p>
      <p className="numeric">
        Per serving: {formatEnergyNumber(recipe.total_kcal / s, energy)} {energyLabel(energy)} · P{' '}
        {Math.round(recipe.total_protein_g / s)} · C {Math.round(recipe.total_carb_g / s)} · F{' '}
        {Math.round(recipe.total_fat_g / s)}
      </p>
      <h2 className="section-header">Ingredients</h2>
      <div className="card">
        {recipe.ingredients.map((i, n) => (
          <div className="row" key={`${i.food.id}-${n}`}>
            <span className="grow name">{i.name}</span>
            <span className="secondary numeric">
              {trim(i.quantity)} {i.food.serving_unit}
            </span>
          </div>
        ))}
      </div>
      {(add.isError || remove.isError) && <p className="error">{(add.error ?? remove.error)!.message}</p>}
      <p style={{ display: 'flex', gap: 'var(--space-m)' }}>
        {recipe.mine ? (
          <button
            className="button danger"
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            Remove from library
          </button>
        ) : (
          <button className="button wide" type="button" onClick={() => add.mutate()} disabled={add.isPending}>
            {add.isPending ? (
              <SmallOrb label="Adding" />
            ) : recipe.added_as ? (
              'Added · add again'
            ) : (
              'Add to my recipes'
            )}
          </button>
        )}
      </p>
    </Sheet>
  );
}
