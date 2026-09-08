// A component naming its view the way Angular actually allows: no leading
// `./`, resolved against this file's own directory. 579 of angular/components'
// 662 template names are written like this.
//
// `styleUrls` names `hero.component.css`, which is not on disk: the source
// beside it is `hero.component.scss` and the name is the build output. That is
// 136 of angular/components' 530 stylesheet names, and it is why the graph
// draws none of them.
declare function Component(meta: {
  selector?: string;
  templateUrl?: string;
  styleUrls?: string[];
}): (value: unknown, context: ClassDecoratorContext) => void;

@Component({
  selector: 'app-hero',
  templateUrl: 'hero.component.html',
  styleUrls: ['hero.component.css'],
})
export class HeroComponent {}
