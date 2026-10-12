import { Route, Routes } from '@angular/router';
import { LayoutStore } from './core/layout.store';
import { DOMINO, PIECE_KIND, PieceKind, TRIMINO } from './core/piece-kind';
import { TemplateService } from './core/template.service';
import { Workspace } from './workspace/workspace';

/**
 * Route-level providers live as long as the app, so each module keeps its own document,
 * layout, undo history and templates while the user switches to the other one.
 */
const module = (kind: PieceKind): Route => ({
  path: kind.id,
  title: kind.title,
  component: Workspace,
  providers: [{ provide: PIECE_KIND, useValue: kind }, LayoutStore, TemplateService],
});

export const routes: Routes = [module(TRIMINO), module(DOMINO), { path: '**', redirectTo: TRIMINO.id }];
