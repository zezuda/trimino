import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Shell; each module (Trimino, Domino) is a route rendering the shared workspace. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {}
