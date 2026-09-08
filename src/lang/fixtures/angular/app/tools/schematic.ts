// The shape that defeats a regexp. angular/components' own schematics compare
// a property's name to the string `templateUrl`; read off the text, this file
// names a template it does not have.
export function isTemplateProperty(propertyName: string): boolean {
  return propertyName === 'templateUrl';
}
