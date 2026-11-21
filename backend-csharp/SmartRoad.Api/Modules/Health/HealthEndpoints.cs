using Microsoft.AspNetCore.Routing;

namespace SmartRoad.Api.Modules.Health;

public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));
        return endpoints;
    }
}
