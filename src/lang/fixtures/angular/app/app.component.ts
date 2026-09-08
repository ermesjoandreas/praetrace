// A component naming its view the way a module specifier is written.
declare function Component(meta: {
  selector?: string;
  templateUrl?: string;
  styleUrls?: string[];
}): (value: unknown, context: ClassDecoratorContext) => void;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
})
export class AppComponent {
  title = 'fixture';
}
