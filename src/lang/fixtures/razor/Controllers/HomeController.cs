using Microsoft.AspNetCore.Mvc;
using Shop.Models;

namespace Shop.Controllers;

public class HomeController : Controller
{
    public IActionResult Index() => View();

    public IActionResult Error() => View(new ErrorViewModel());
}
