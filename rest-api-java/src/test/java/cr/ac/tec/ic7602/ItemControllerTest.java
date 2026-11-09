package cr.ac.tec.ic7602;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(ItemController.class)
class ItemControllerTest {
    @Autowired
    private MockMvc mvc;

    @Test
    void healthIsAvailable() throws Exception {
        mvc.perform(get("/api/health"))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("rest-api-java")));
    }

    @Test
    void itemCanBeCreatedReadUpdatedAndDeleted() throws Exception {
        String location = mvc.perform(post("/api/items.json").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"bike\",\"price\":10}"))
                .andExpect(status().isCreated())
                .andExpect(header().exists("Location"))
                .andExpect(content().string(containsString("\"name\":\"bike\"")))
                .andReturn().getResponse().getHeader("Location");

        mvc.perform(get(location))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("\"price\":10")));

        mvc.perform(put(location).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"bus\"}"))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("\"name\":\"bus\"")));

        mvc.perform(delete(location)).andExpect(status().isNoContent());
        mvc.perform(get(location)).andExpect(status().isNotFound());
    }

    @Test
    void malformedJsonAndUnknownItemsAreRejected() throws Exception {
        mvc.perform(post("/api/items.json").contentType(MediaType.APPLICATION_JSON).content("{"))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/items/999999999.json")).andExpect(status().isNotFound());
        mvc.perform(put("/api/items/999999999.json").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isNotFound());
        mvc.perform(delete("/api/items/999999999.json")).andExpect(status().isNotFound());
    }
}
