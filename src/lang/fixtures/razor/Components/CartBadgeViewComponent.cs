using Microsoft.AspNetCore.Mvc;

namespace Shop.Components;

public class CartBadgeViewComponent : ViewComponent
{
    public IViewComponentResult Invoke() => View();
}
